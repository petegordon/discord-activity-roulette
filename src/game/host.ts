import type { Msg, Player } from "../net/protocol";
import { normalizeSpin, spinDurationMs, type SpinInput, type SpinPlan } from "../wheel/spin";
import { isSpot, POCKETS, ROUND_OPTIONS, WHEEL_ORDER } from "./rules";
import {
  addPlayer,
  applySpin,
  canSpin,
  clearBets,
  createGame,
  placeBet,
  rematch,
  removePlayer,
  startMatch,
  type GameState,
} from "./roulette";

export const PLAYER_COLORS = ["#e63946", "#2a9d8f", "#f4a261", "#457b9d", "#9b5de5", "#f15bb5", "#00b4d8", "#80b918"];

/**
 * Spins and bets are refused until the ball has settled on the host. Clients
 * start their animation later than the host does, so they always finish after this.
 */
const LANDING_SLACK_MS = 100;
const MAX_NAME = 24;
/** Ids are 16 hex chars (see identityKey.ts). */
const REMOTE_ID_RE = /^[0-9a-f]{16}$/;

/** Fair pick from a CSPRNG, rejecting the biased top of the range. */
export function randomPocket(): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / POCKETS) * POCKETS;
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return WHEEL_ORDER[buf[0] % POCKETS];
}

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

export type HostDeps = {
  /** The host's own player id. */
  selfId: string;
  now?: () => number;
  newId?: () => string;
  pickPocket?: () => number;
  newSeed?: () => number;
};

export function sanitizeName(name: unknown): string {
  const clean = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME) : "";
  return clean || "Player";
}

function sanitizeAvatar(url: unknown): string | undefined {
  return typeof url === "string" && /^https:\/\/cdn\.discordapp\.com\//.test(url) ? url : undefined;
}

/**
 * The authoritative game, run only by the current network host. Every method
 * returns the messages to broadcast; it never touches the network itself.
 */
export class HostAuthority {
  players: Player[] = [];
  game: GameState = createGame();
  private busyUntil = 0;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly pickPocket: () => number;
  private readonly newSeed: () => number;

  constructor(private readonly deps: HostDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.pickPocket = deps.pickPocket ?? randomPocket;
    this.newSeed = deps.newSeed ?? randomSeed;
  }

  /** Take over from a previous host using the last state everyone agreed on. */
  restore(players: Player[], game: GameState) {
    this.players = players.map((p) => ({ ...p }));
    this.game = game;
    this.busyUntil = 0;
  }

  state(): Msg {
    return { t: "state", players: this.players, game: this.game, hostId: this.deps.selfId };
  }

  join(from: string, hello: { name?: unknown; avatarUrl?: unknown }): Msg[] {
    const existing = this.players.find((p) => p.id === from);
    const name = sanitizeName(hello.name);
    const avatarUrl = sanitizeAvatar(hello.avatarUrl);
    if (existing) {
      existing.name = name;
      existing.avatarUrl = avatarUrl;
    } else {
      const used = new Set(this.players.map((p) => p.color));
      const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[this.players.length % PLAYER_COLORS.length];
      const joinedAt = Math.max(this.now(), ...this.players.map((p) => p.joinedAt + 1));
      this.players.push({ id: from, name, avatarUrl, color, joinedAt });
      this.game = addPlayer(this.game, from);
    }
    return [this.state()];
  }

  leave(id: string): Msg[] {
    if (!this.players.some((p) => p.id === id)) return [];
    this.players = this.players.filter((p) => p.id !== id);
    this.game = removePlayer(this.game, id);
    return [this.state()];
  }

  /** Drop everyone not in `present` (used after a host migration). */
  prune(present: Set<string>): Msg[] {
    const gone = this.players.filter((p) => !present.has(p.id)).map((p) => p.id);
    return gone.length ? gone.flatMap((id) => this.leave(id)).slice(-1) : [];
  }

  start(rounds: number): Msg[] {
    if (this.game.phase === "betting" || this.players.length === 0) return [];
    const r = (ROUND_OPTIONS as readonly number[]).includes(rounds) ? rounds : this.game.rounds;
    this.game = startMatch(this.game, r);
    return [this.state()];
  }

  rematch(): Msg[] {
    if (this.game.phase !== "matchOver") return [];
    this.game = rematch(this.game);
    return [this.state()];
  }

  bet(from: string, spot: unknown, amount: unknown): Msg[] {
    if (this.now() < this.busyUntil || !isSpot(spot) || typeof amount !== "number") return [];
    const next = placeBet(this.game, from, spot, amount);
    if (next === this.game) return [];
    this.game = next;
    return [this.state()];
  }

  clearBets(from: string): Msg[] {
    if (this.now() < this.busyUntil) return [];
    const next = clearBets(this.game, from);
    if (next === this.game) return [];
    this.game = next;
    return [this.state()];
  }

  spin(from: string, input: SpinInput): Msg[] {
    if (!canSpin(this.game, from) || this.now() < this.busyUntil) return [];
    const { wheel, ball } = normalizeSpin(input);
    const plan: SpinPlan = { spinId: this.newId(), spinner: from, pocket: this.pickPocket(), wheel, ball, seed: this.newSeed() };
    this.game = applySpin(this.game, plan.spinId, plan.pocket);
    const landsInMs = spinDurationMs(ball);
    this.busyUntil = this.now() + landsInMs - LANDING_SLACK_MS;
    return [{ t: "spun", plan, game: this.game, landsInMs }];
  }

  /** Make `remoteId` the player's spinner remote. A remote belongs to one player at a time. */
  pair(from: string, remoteId: unknown): Msg[] {
    const player = this.players.find((p) => p.id === from);
    if (!player || typeof remoteId !== "string" || !REMOTE_ID_RE.test(remoteId)) return [];
    if (this.players.some((p) => p.id === remoteId)) return [];
    for (const p of this.players) {
      if (p.remoteId === remoteId) {
        delete p.remoteId;
        delete p.remoteOnline;
      }
    }
    player.remoteId = remoteId;
    player.remoteOnline = false;
    return [this.state()];
  }

  unpair(from: string): Msg[] {
    const player = this.players.find((p) => p.id === from);
    if (!player?.remoteId) return [];
    delete player.remoteId;
    delete player.remoteOnline;
    return [this.state()];
  }

  /** Called with everyone connected; updates the 📱 badges. */
  remotesOnline(connected: Set<string>): Msg[] {
    let changed = false;
    for (const p of this.players) {
      if (!p.remoteId) continue;
      const online = connected.has(p.remoteId);
      if (p.remoteOnline !== online) {
        p.remoteOnline = online;
        changed = true;
      }
    }
    return changed ? [this.state()] : [];
  }

  /**
   * Requests addressed to the host. Broadcast-only messages are ignored.
   * A spinner remote (`remote`, set by the transport) may only ask for the
   * state and spin for the player it's paired with.
   */
  handle(from: string, msg: Msg, remote = false): Msg[] {
    if (remote) {
      if (msg.t === "remote-hello") return [this.state()];
      if (msg.t !== "spin") return [];
      const owner = this.players.find((p) => p.remoteId === from);
      return owner ? this.spin(owner.id, msg.input) : [];
    }
    switch (msg.t) {
      case "hello":
        return this.join(from, msg.player ?? {});
      case "bet":
        return this.bet(from, msg.spot, msg.amount);
      case "clear-bets":
        return this.clearBets(from);
      case "spin":
        return this.spin(from, msg.input);
      case "pair":
        return this.pair(from, msg.remoteId);
      case "unpair":
        return this.unpair(from);
      default:
        return [];
    }
  }
}

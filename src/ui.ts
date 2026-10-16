import { net, staked, type GameState, type SpinRecord } from "./game/roulette";
import { CHIP_VALUES, OUTSIDE_SPOTS, pocketColor, ROUND_OPTIONS, DEFAULT_ROUNDS, spotLabel, type Spot } from "./game/rules";
import type { Player } from "./net/protocol";
import type { TransportStatus } from "./net/transport";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { className?: string; text?: string } = {}, ...children: Node[]) {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  node.append(...children);
  return node;
}

export type View = {
  players: Player[];
  game: GameState;
  selfId: string;
  hostId: string | null;
  isHost: boolean;
  /** Bets can be placed right now (betting, and the ball isn't rolling). */
  bettingOpen: boolean;
};

export type UIHandlers = {
  start: (rounds: number) => void;
  rematch: () => void;
  quickSpin: () => void;
  enableMotion: () => void;
  toggleMute: () => boolean;
  copyInvite: () => Promise<void>;
  bet: (spot: Spot, amount: number) => void;
  undoBet: () => void;
  clearBets: () => void;
  /** Open the spinner-remote sheet (📱). */
  openRemote: () => void;
  remoteOpenHere: () => void;
  remoteNewLink: () => void;
  remoteUnpair: () => void;
};

/** The pairing sheet's contents. See SPINNER-REMOTE.md. */
export type PairView = {
  link: string;
  qrSvg: string;
  why: string;
  /** Show "Open on this phone" (Discord on a phone). */
  canOpenHere: boolean;
  paired: boolean;
  online: boolean;
};

/** How the spin zone looks on your turn when your phone is the spinner. */
export type RemoteZone = { online: boolean; why: string };

export type ZoneState = "twist" | "flick" | "spinning" | "settling" | "waiting" | "hidden";

export const fmt = (n: number) => n.toLocaleString("en-US");
const short = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : "±0");

export function pocketLabel(n: number): string {
  const c = pocketColor(n);
  return c === "green" ? `${n} GREEN` : `${n} ${c.toUpperCase()}`;
}

/** Where each spot sits on the 14 × 5 table grid: [column, row, column span, row span]. */
function spotCell(spot: Spot): [number, number, number, number] {
  if (spot === "n0") return [1, 1, 1, 3];
  if (spot.startsWith("n")) {
    const n = Number(spot.slice(1));
    return [2 + Math.floor((n - 1) / 3), 3 - ((n - 1) % 3), 1, 1];
  }
  const outside: Record<string, [number, number, number, number]> = {
    c3: [14, 1, 1, 1],
    c2: [14, 2, 1, 1],
    c1: [14, 3, 1, 1],
    d1: [2, 4, 4, 1],
    d2: [6, 4, 4, 1],
    d3: [10, 4, 4, 1],
    low: [2, 5, 2, 1],
    even: [4, 5, 2, 1],
    red: [6, 5, 2, 1],
    black: [8, 5, 2, 1],
    odd: [10, 5, 2, 1],
    high: [12, 5, 2, 1],
  };
  return outside[spot];
}

function boardText(spot: Spot): string {
  if (spot.startsWith("n")) return spot.slice(1);
  if (spot.startsWith("c")) return "2:1";
  if (spot === "red" || spot === "black") return "";
  return spotLabel(spot);
}

export class UI {
  readonly zone = $("zone");
  private callout = $("callout");
  private hintTimer: ReturnType<typeof setTimeout> | undefined;
  private lastCalloutSpin: string | null = null;
  private chip: number = CHIP_VALUES[0];
  private cells = new Map<Spot, HTMLButtonElement>();

  constructor(
    private readonly handlers: UIHandlers,
    muted: boolean,
  ) {
    const rounds = $<HTMLSelectElement>("rounds");
    for (const n of ROUND_OPTIONS) rounds.append(new Option(String(n), String(n), n === DEFAULT_ROUNDS, n === DEFAULT_ROUNDS));
    $("start").addEventListener("click", () => handlers.start(Number(rounds.value)));
    $("rematch").addEventListener("click", () => handlers.rematch());
    $("quick-spin").addEventListener("click", () => handlers.quickSpin());
    $("enable-motion").addEventListener("click", () => handlers.enableMotion());
    const mute = $("mute");
    const paintMute = (m: boolean) => {
      mute.textContent = m ? "🔇" : "🔊";
      mute.setAttribute("aria-label", m ? "Unmute sounds" : "Mute sounds");
    };
    paintMute(muted);
    mute.addEventListener("click", () => paintMute(handlers.toggleMute()));
    $("copy-invite").addEventListener("click", async () => {
      const btn = $("copy-invite");
      try {
        await handlers.copyInvite();
        btn.textContent = "Copied!";
      } catch {
        btn.textContent = "Copy failed";
      }
      setTimeout(() => (btn.textContent = "Copy invite"), 1600);
    });
    $("remote-btn").addEventListener("click", () => handlers.openRemote());
    $("use-phone").addEventListener("click", () => handlers.openRemote());
    $("lobby-phone").addEventListener("click", () => handlers.openRemote());
    $("pair-open").addEventListener("click", () => handlers.remoteOpenHere());
    $("pair-new").addEventListener("click", () => handlers.remoteNewLink());
    $("pair-unpair").addEventListener("click", () => handlers.remoteUnpair());
    $("pair-close").addEventListener("click", () => this.hidePair());
    $("pair").addEventListener("click", (e) => e.target === $("pair") && this.hidePair());
    $("pair-copy").addEventListener("click", () => this.copyPairLink());
    $("undo-bet").addEventListener("click", () => handlers.undoBet());
    $("clear-bets").addEventListener("click", () => handlers.clearBets());
    this.buildBoard();
    this.buildChips();
  }

  private buildBoard() {
    const board = $("board");
    const spots: Spot[] = [...Array.from({ length: 37 }, (_, n) => `n${n}` as Spot), ...OUTSIDE_SPOTS];
    for (const spot of spots) {
      const [col, row, cs, rs] = spotCell(spot);
      const cell = el("button", { className: "spot" });
      cell.type = "button";
      cell.style.gridArea = `${row} / ${col} / span ${rs} / span ${cs}`;
      if (spot.startsWith("n")) cell.classList.add(pocketColor(Number(spot.slice(1))));
      else cell.classList.add("outside", spot);
      cell.dataset.spot = spot;
      cell.append(el("span", { className: "label", text: boardText(spot) }));
      if (spot === "red" || spot === "black") cell.append(el("span", { className: "diamond" }));
      cell.setAttribute("aria-label", `Bet on ${spotLabel(spot)}`);
      cell.addEventListener("click", () => this.handlers.bet(spot, this.chip));
      board.append(cell);
      this.cells.set(spot, cell);
    }
  }

  private buildChips() {
    const row = $("chips");
    for (const v of CHIP_VALUES) {
      const b = el("button", { className: `chip-pick v${v}`, text: String(v) });
      b.type = "button";
      b.setAttribute("role", "radio");
      b.addEventListener("click", () => {
        this.chip = v;
        this.paintChips();
      });
      row.append(b);
    }
    this.paintChips();
  }

  private paintChips() {
    for (const b of $("chips").children) {
      const on = Number(b.textContent) === this.chip;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
  }

  askName(initial: string): Promise<string> {
    const layer = $("name-prompt");
    const input = $<HTMLInputElement>("name-input");
    input.value = initial;
    layer.hidden = false;
    setTimeout(() => input.focus(), 50);
    return new Promise((resolve) => {
      $("name-form").addEventListener(
        "submit",
        (e) => {
          e.preventDefault();
          const name = input.value.trim() || "Player";
          this.removeNamePrompt();
          resolve(name);
        },
        { once: true },
      );
    });
  }

  /**
   * Take the name field out of the page for good. iOS "Shake to Undo" offers
   * to undo typing in any text field still in the document, which pops up
   * when a player flicks their phone.
   */
  removeNamePrompt() {
    const input = document.getElementById("name-input");
    if (input === document.activeElement) (input as HTMLInputElement).blur();
    document.getElementById("name-prompt")?.remove();
  }

  setRoom(code: string, showInvite: boolean) {
    $("room-code").textContent = code.length > 8 ? code.slice(0, 6) + "…" : code;
    $("copy-invite").hidden = !showInvite;
  }

  render(v: View) {
    const { game, players, selfId } = v;
    const byId = new Map(players.map((p) => [p.id, p]));
    const spinner = game.spinnerId ? byId.get(game.spinnerId) : undefined;
    const playing = game.phase === "betting";

    // Players bar: chips in hand, plus what's on the table.
    $("players").replaceChildren(
      ...game.turnOrder
        .map((id) => byId.get(id))
        .filter((p): p is Player => !!p)
        .map((p) => {
          const li = el("li", { className: "player" + (p.id === game.spinnerId && playing ? " spinner" : "") });
          li.style.setProperty("--pc", p.color);
          li.append(avatar(p), el("span", { className: "name", text: p.id === selfId ? `${p.name} (you)` : p.name }));
          if (p.remoteId) {
            const badge = el("span", { className: "remote-badge" + (p.remoteOnline ? " online" : ""), text: "📱" });
            badge.title = p.remoteOnline ? "Spinning with their phone" : "Phone remote offline";
            li.append(badge);
          }
          if (game.phase !== "lobby") {
            li.append(el("span", { className: "score", text: fmt(game.chips[p.id] ?? 0) }));
            const bet = staked(game.bets[p.id]);
            if (bet) li.append(el("span", { className: "bet-tag", text: `+${short(bet)}` }));
          }
          return li;
        }),
    );

    // Banner.
    const banner = $("banner");
    banner.replaceChildren();
    if (playing && spinner) {
      banner.append(el("b", { text: `Spin ${Math.min(game.spun + 1, game.rounds)} of ${game.rounds}` }));
      banner.append(` · ${spinner.id === selfId ? "your spin" : `${spinner.name} spins`}`);
    }

    // Betting table.
    $("board-wrap").hidden = !playing;
    if (playing) this.renderBoard(v, byId);

    // Lobby card.
    $("lobby").hidden = game.phase !== "lobby";
    if (game.phase === "lobby") {
      $("lobby-players").replaceChildren(...players.map((p) => playerRow(p, p.id === v.hostId ? "host" : p.id === selfId ? "you" : "")));
      $("host-controls").hidden = !v.isHost;
      $("lobby-wait").hidden = v.isHost;
    }

    // Match over card.
    const over = game.phase === "matchOver";
    $("match-over").hidden = !over;
    if (over) {
      const winners = game.winnerIds.map((id) => byId.get(id)).filter((p): p is Player => !!p);
      const names = winners.map((p) => (p.id === selfId ? "You" : p.name));
      $("winner").textContent =
        winners.length === 0 ? "Game over" : winners.length === 1 ? (names[0] === "You" ? "You win!" : `${names[0]} wins!`) : `${names.join(" & ")} tie!`;
      const ranked = [...game.turnOrder].sort((a, b) => (game.chips[b] ?? 0) - (game.chips[a] ?? 0));
      $("final-scores").replaceChildren(
        ...ranked.map((id) => byId.get(id)).filter((p): p is Player => !!p).map((p) => playerRow(p, fmt(game.chips[p.id] ?? 0), true)),
      );
      $("rematch").hidden = !v.isHost;
      $("rematch-wait").hidden = v.isHost;
    }
  }

  private renderBoard(v: View, byId: Map<string, Player>) {
    const { game, selfId } = v;
    const board = $("board");
    board.classList.toggle("locked", !v.bettingOpen);
    const mine = game.bets[selfId] ?? {};
    for (const [spot, cell] of this.cells) {
      cell.disabled = !v.bettingOpen;
      cell.querySelector(".stack")?.remove();
      const others = game.turnOrder.filter((id) => id !== selfId && (game.bets[id]?.[spot] ?? 0) > 0);
      const amount = mine[spot] ?? 0;
      if (!amount && !others.length) continue;
      const stack = el("span", { className: "stack" });
      if (amount) stack.append(el("span", { className: "my-chip", text: short(amount) }));
      for (const id of others.slice(0, 3)) {
        const dot = el("span", { className: "dot" });
        dot.style.setProperty("--pc", byId.get(id)?.color ?? "#888");
        stack.append(dot);
      }
      cell.append(stack);
    }
    const last = game.lastSpin?.pocket;
    for (const [spot, cell] of this.cells) cell.classList.toggle("last", last !== undefined && spot === `n${last}`);

    const stake = staked(mine);
    $("my-stake").textContent = stake ? `Your bets: ${fmt(stake)} · in hand ${fmt(game.chips[selfId] ?? 0)}` : `In hand: ${fmt(game.chips[selfId] ?? 0)}`;
    $<HTMLButtonElement>("undo-bet").disabled = !v.bettingOpen || !stake;
    $<HTMLButtonElement>("clear-bets").disabled = !v.bettingOpen || !stake;

    $("recent").replaceChildren(
      ...game.history.slice(0, 10).map((r) => {
        const li = el("li", { className: `ball ${r.color}`, text: String(r.pocket) });
        li.title = pocketLabel(r.pocket);
        return li;
      }),
    );
  }

  /** The spin zone: yours to twist and flick, or showing whose spin it is. */
  setZone(state: ZoneState, opts: { color?: string; motion?: boolean; spinnerName?: string; remote?: RemoteZone } = {}) {
    const zone = this.zone;
    const mine = state === "twist" || state === "flick";
    const remote = mine ? opts.remote : undefined;
    zone.hidden = state === "hidden";
    zone.classList.toggle("mine", mine);
    zone.classList.toggle("flick", state === "flick" && !remote);
    zone.classList.toggle("remote", !!remote);
    zone.classList.toggle("waiting", !mine);
    $("use-phone").hidden = !remote || remote.online;
    if (opts.color) zone.style.setProperty("--pc", opts.color);
    const title = zone.querySelector(".zone-title")!;
    const sub = zone.querySelector(".zone-sub")!;
    if (remote) {
      title.textContent = remote.online ? "SPIN WITH YOUR PHONE" : "YOUR SPIN";
      sub.textContent = remote.online ? "Twist it to spin the wheel, then flick it to launch the ball" : remote.why;
      zone.setAttribute("aria-label", remote.online ? "Spin with your phone" : "Your spin");
    } else if (state === "twist") {
      title.textContent = "HOLD & TWIST";
      sub.textContent = opts.motion ? "Hold here and twist your phone like a dial to spin the wheel" : "Hold here and drag sideways to spin the wheel";
      zone.setAttribute("aria-label", "Hold and twist to spin the wheel");
    } else if (state === "flick") {
      title.textContent = "NOW FLICK!";
      sub.textContent = opts.motion ? "Hold here and flick your phone forward to launch the ball" : "Hold and flick upward to launch the ball";
      zone.setAttribute("aria-label", "Hold and flick to launch the ball");
    } else if (state === "spinning") {
      title.textContent = "No more bets";
      sub.textContent = "";
    } else if (state === "settling") {
      title.textContent = opts.spinnerName ? `${opts.spinnerName} spins next` : "Get ready…";
      sub.textContent = "";
    } else {
      title.textContent = opts.spinnerName ? `${opts.spinnerName} is spinning` : "Waiting…";
      sub.textContent = "Place your bets";
    }
    $("quick-spin").hidden = !mine;
  }

  setHolding(holding: boolean) {
    this.zone.classList.toggle("holding", holding);
  }

  showEnableMotion(show: boolean) {
    $("enable-motion").hidden = !show;
  }

  showRemoteButton(show: boolean) {
    $("remote-btn").hidden = !show;
  }

  /** Offer pairing up front in the lobby where there's no motion. */
  showLobbyPhone(show: boolean) {
    $("lobby-phone").hidden = !show;
  }

  get pairOpen() {
    return !$("pair").hidden;
  }

  showPair(v: PairView) {
    $("pair-why").textContent = v.why;
    // uqr renders a plain <svg> of rects from our own link; nothing user-supplied.
    $("pair-qr").innerHTML = v.qrSvg;
    $("pair-link").textContent = v.link;
    $("pair-open").hidden = !v.canOpenHere;
    $("pair-unpair").hidden = !v.paired;
    const status = $("pair-status");
    status.textContent = v.online ? "✅ Phone connected. Spin with it on your turn!" : "Waiting for your phone… Scan the code with its camera.";
    status.classList.toggle("ok", v.online);
    $("pair").hidden = false;
  }

  openPair() {
    $("pair").hidden = false;
  }

  hidePair() {
    $("pair").hidden = true;
  }

  /** The clipboard is blocked in the Discord iframe; fall back to selecting the link for a manual copy. */
  private async copyPairLink() {
    const link = $("pair-link");
    const btn = $("pair-copy");
    try {
      await navigator.clipboard.writeText(link.textContent ?? "");
      btn.textContent = "Copied!";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(link);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      btn.textContent = "Selected — copy it";
    }
    setTimeout(() => (btn.textContent = "Copy link"), 2000);
  }

  hint(text: string, ms = 2400) {
    const h = $("hint");
    h.textContent = text;
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => (h.textContent = ""), ms);
  }

  announceSpin(record: SpinRecord, players: Player[], selfId: string, gameOver: boolean) {
    if (record.spinId === this.lastCalloutSpin) return;
    this.lastCalloutSpin = record.spinId;
    const { main, sub, tone } = spinCallout(record, players, selfId);
    this.showCallout(main, gameOver ? `${sub} · game over` : sub, tone, record.color);
  }

  private showCallout(main: string, sub: string, tone: "hit" | "miss" | "none", color: string) {
    const c = this.callout;
    c.querySelector(".callout-main")!.textContent = main;
    c.querySelector(".callout-sub")!.textContent = sub;
    c.className = `callout ${tone} ${color}`;
    void c.offsetWidth; // restart the animation
    c.classList.add("show");
  }

  status(s: TransportStatus | null, relayLink?: string) {
    const box = $("status");
    box.className = "status";
    box.replaceChildren();
    if (!s || s.kind === "connected") {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (s.kind === "connecting") box.textContent = "Connecting to the table…";
    else if (s.kind === "reconnecting") box.textContent = "Connection lost — reconnecting…";
    else {
      box.classList.add("error");
      box.append(s.reason);
      if (relayLink) {
        const a = el("a", { text: "Use the relay instead" });
        a.href = relayLink;
        box.append(" ", a);
      }
    }
  }

  fatal(message: string) {
    this.status({ kind: "failed", reason: message });
    this.setZone("hidden");
  }
}

/** The result callout for a spin, from `selfId`'s point of view. Shared with the phone remote. */
export function spinCallout(record: SpinRecord, players: Player[], selfId: string): { main: string; sub: string; tone: "hit" | "miss" | "none" } {
  const main = pocketLabel(record.pocket);
  const mine = record.results[selfId];
  const others = Object.entries(record.results)
    .filter(([id]) => id !== selfId)
    .map(([id, r]) => ({ name: players.find((p) => p.id === id)?.name ?? "Someone", n: net(r) }))
    .sort((a, b) => b.n - a.n);
  const big = others[0];
  const theirs = big && big.n > 0 ? `${big.name} ${signed(big.n)}` : "";
  if (mine) {
    const n = net(mine);
    const sub = n > 0 ? `You win ${signed(n)}!` : n < 0 ? `You lose ${fmt(-n)}` : "You break even";
    return { main, sub: theirs ? `${sub} · ${theirs}` : sub, tone: n > 0 ? "hit" : n < 0 ? "miss" : "none" };
  }
  return { main, sub: theirs || (others.length ? "The house wins" : "No bets this spin"), tone: "none" };
}

function avatar(p: Player): HTMLElement {
  if (p.avatarUrl) {
    const img = el("img", { className: "avatar" });
    img.alt = "";
    img.src = p.avatarUrl;
    img.referrerPolicy = "no-referrer";
    img.onerror = () => img.replaceWith(initialBadge(p));
    return img;
  }
  return initialBadge(p);
}

function initialBadge(p: Player): HTMLElement {
  const span = el("span", { className: "avatar", text: (p.name.trim()[0] ?? "?").toUpperCase() });
  span.style.setProperty("--pc", p.color);
  return span;
}

function playerRow(p: Player, tag: string, scoreTag = false): HTMLElement {
  const li = el("li");
  li.style.setProperty("--pc", p.color);
  li.append(el("span", { className: "swatch" }), el("span", { className: "grow", text: p.name }), el("span", { className: scoreTag ? "score" : "muted", text: tag }));
  return li;
}

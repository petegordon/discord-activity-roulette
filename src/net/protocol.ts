import type { GameState } from "../game/roulette";
import type { Spot } from "../game/rules";
import type { SpinInput, SpinPlan } from "../wheel/spin";

export type { SpinInput, SpinPlan };

export type Player = {
  id: string;
  name: string;
  avatarUrl?: string;
  color: string;
  joinedAt: number;
  /** Id of the phone paired as this player's spinner remote (see SPINNER-REMOTE.md). */
  remoteId?: string;
  /** Whether that phone is connected right now. */
  remoteOnline?: boolean;
};

export type Msg =
  /** peer → host, on (re)connect */
  | { t: "hello"; player: { name: string; avatarUrl?: string } }
  /** host → all, whenever players or game change outside a spin */
  | { t: "state"; players: Player[]; game: GameState; hostId: string }
  /** spinner → all, ~15 Hz while twisting: the wheel's angular velocity (rad/s). Cosmetic. */
  | { t: "twist"; rate: number }
  /** player → host: add chips to a spot (negative takes them back) */
  | { t: "bet"; spot: Spot; amount: number }
  /** player → host: take all my chips back */
  | { t: "clear-bets" }
  /** spinner (or their remote) → host: the ball was launched */
  | { t: "spin"; input: SpinInput }
  /** host → all. `game` is the state to show once the ball settles, about `landsInMs` after this arrives. */
  | { t: "spun"; plan: SpinPlan; game: GameState; landsInMs?: number }
  /** player → host: make this remote id my spinner remote, replacing any other */
  | { t: "pair"; remoteId: string }
  /** player → host: forget my spinner remote */
  | { t: "unpair" }
  /** remote → host, on (re)connect: please send the current state */
  | { t: "remote-hello" };

export type Target = "host" | "all";

/**
 * `remote` is set by the relay or the PeerJS host when the sender connected
 * as a spinner remote. It is never taken from the sender.
 */
export type Envelope = { from: string; to: Target; msg: Msg; remote?: boolean };

/** The only message type a non-host may broadcast; transports drop the rest. */
export const CLIENT_BROADCASTS: ReadonlySet<string> = new Set(["twist"]);

/** Cosmetic broadcasts that transports rate-limit per sender. */
export const THROTTLED = "twist";

const MSG_TYPES = new Set(["hello", "state", "twist", "bet", "clear-bets", "spin", "spun", "pair", "unpair", "remote-hello"]);

export type Role = "player" | "remote";

/** Light structural validation for anything arriving off the wire. */
export function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const msg = v.msg as Record<string, unknown> | undefined;
  return (
    typeof v.from === "string" &&
    (v.to === "host" || v.to === "all") &&
    !!msg &&
    typeof msg === "object" &&
    typeof msg.t === "string" &&
    MSG_TYPES.has(msg.t)
  );
}

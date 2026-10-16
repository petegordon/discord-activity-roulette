import { DEFAULT_ROUNDS, MAX_SPOT_BET, pocketColor, settle, STARTING_CHIPS, type PocketColor, type Spot } from "./rules";

export type Bets = Partial<Record<Spot, number>>;

/** What one player had on the table for a spin, and what came back. */
export type SpinResult = { staked: number; returned: number };

export type SpinRecord = {
  spinId: string;
  spinner: string;
  pocket: number;
  color: PocketColor;
  /** Only players who had chips on the table. */
  results: Record<string, SpinResult>;
};

export type GamePhase = "lobby" | "betting" | "matchOver";

export type GameState = {
  phase: GamePhase;
  /** Whose turn it is to spin the wheel. */
  spinnerId: string | null;
  /** Player ids in turn order (join order). */
  turnOrder: string[];
  /** Chips in hand, not counting chips on the table. */
  chips: Record<string, number>;
  /** Chips on the table for the coming spin. */
  bets: Record<string, Bets>;
  /** Spins in this match. */
  rounds: number;
  /** Spins completed so far. */
  spun: number;
  /** Most chips at the end; more than one on a tie. */
  winnerIds: string[];
  lastSpin: SpinRecord | null;
  /** Most recent first, capped at HISTORY_LIMIT. */
  history: SpinRecord[];
  /** Index into turnOrder of the first spinner of the current match; rotates on rematch. */
  firstSpinnerIndex: number;
};

export const HISTORY_LIMIT = 20;

export function createGame(rounds = DEFAULT_ROUNDS): GameState {
  return {
    phase: "lobby",
    spinnerId: null,
    turnOrder: [],
    chips: {},
    bets: {},
    rounds,
    spun: 0,
    winnerIds: [],
    lastSpin: null,
    history: [],
    firstSpinnerIndex: 0,
  };
}

export const staked = (bets: Bets | undefined) => Object.values(bets ?? {}).reduce<number>((sum, v) => sum + (v ?? 0), 0);

export function addPlayer(state: GameState, id: string): GameState {
  if (state.turnOrder.includes(id)) return state;
  return {
    ...state,
    turnOrder: [...state.turnOrder, id],
    chips: { ...state.chips, [id]: state.chips[id] ?? STARTING_CHIPS },
  };
}

export function removePlayer(state: GameState, id: string): GameState {
  const idx = state.turnOrder.indexOf(id);
  if (idx === -1) return state;
  const turnOrder = state.turnOrder.filter((p) => p !== id);
  // Their chips (bets included) are kept, so a player who drops out and rejoins gets them back.
  const chips = { ...state.chips, [id]: (state.chips[id] ?? 0) + staked(state.bets[id]) };
  const bets = { ...state.bets };
  delete bets[id];

  if (turnOrder.length === 0) {
    return { ...createGame(state.rounds), history: state.history };
  }

  let { spinnerId, phase } = state;
  // The player after the leaver now sits at the leaver's old index.
  if (spinnerId === id) spinnerId = turnOrder[idx % turnOrder.length];
  if (phase === "matchOver" && state.winnerIds.includes(id) && state.winnerIds.length === 1) phase = "lobby";
  return {
    ...state,
    phase,
    turnOrder,
    spinnerId,
    chips,
    bets,
    firstSpinnerIndex: Math.min(state.firstSpinnerIndex, turnOrder.length - 1),
  };
}

export function startMatch(state: GameState, rounds = state.rounds): GameState {
  if (state.turnOrder.length === 0) return state;
  const first = state.firstSpinnerIndex % state.turnOrder.length;
  return {
    ...state,
    phase: "betting",
    rounds,
    spun: 0,
    chips: Object.fromEntries(state.turnOrder.map((id) => [id, STARTING_CHIPS])),
    bets: {},
    winnerIds: [],
    lastSpin: null,
    spinnerId: state.turnOrder[first],
  };
}

/** Back to the lobby with the next player as first spinner. */
export function rematch(state: GameState): GameState {
  const n = Math.max(state.turnOrder.length, 1);
  return {
    ...state,
    phase: "lobby",
    spinnerId: null,
    bets: {},
    winnerIds: [],
    firstSpinnerIndex: (state.firstSpinnerIndex + 1) % n,
  };
}

/**
 * Add `amount` chips to `spot` (negative takes them back). Returns the state
 * unchanged if the bet isn't possible: not betting, not enough chips, or more
 * than MAX_SPOT_BET on the spot.
 */
export function placeBet(state: GameState, playerId: string, spot: Spot, amount: number): GameState {
  if (state.phase !== "betting" || !state.turnOrder.includes(playerId) || !Number.isInteger(amount) || amount === 0) return state;
  const mine = state.bets[playerId] ?? {};
  const current = mine[spot] ?? 0;
  const next = current + amount;
  const inHand = state.chips[playerId] ?? 0;
  if (next < 0 || next > MAX_SPOT_BET || amount > inHand) return state;
  const updated: Bets = { ...mine };
  if (next === 0) delete updated[spot];
  else updated[spot] = next;
  return {
    ...state,
    chips: { ...state.chips, [playerId]: inHand - amount },
    bets: { ...state.bets, [playerId]: updated },
  };
}

/** Take all of a player's chips back off the table. */
export function clearBets(state: GameState, playerId: string): GameState {
  if (state.phase !== "betting" || !state.bets[playerId]) return state;
  const bets = { ...state.bets };
  delete bets[playerId];
  return { ...state, chips: { ...state.chips, [playerId]: (state.chips[playerId] ?? 0) + staked(state.bets[playerId]) }, bets };
}

export function canSpin(state: GameState, playerId: string): boolean {
  return state.phase === "betting" && state.spinnerId === playerId;
}

export function nextSpinner(state: GameState, current: string): string {
  const idx = state.turnOrder.indexOf(current);
  return state.turnOrder[(idx + 1) % state.turnOrder.length];
}

/** The ball landed on `pocket`: pay out, clear the table, and pass the wheel on (or end the match). */
export function applySpin(state: GameState, spinId: string, pocket: number): GameState {
  if (state.phase !== "betting" || !state.spinnerId) return state;
  const chips = { ...state.chips };
  const results: Record<string, SpinResult> = {};
  for (const id of state.turnOrder) {
    const bets = state.bets[id];
    const stake = staked(bets);
    if (!stake) continue;
    const returned = settle(bets!, pocket);
    results[id] = { staked: stake, returned };
    chips[id] = (chips[id] ?? 0) + returned;
  }
  const record: SpinRecord = { spinId, spinner: state.spinnerId, pocket, color: pocketColor(pocket), results };
  const history = [record, ...state.history].slice(0, HISTORY_LIMIT);
  const spun = state.spun + 1;
  const base = { ...state, chips, bets: {}, spun, lastSpin: record, history };
  if (spun >= state.rounds) {
    const best = Math.max(...state.turnOrder.map((id) => chips[id] ?? 0));
    return { ...base, phase: "matchOver", winnerIds: state.turnOrder.filter((id) => (chips[id] ?? 0) === best) };
  }
  return { ...base, spinnerId: nextSpinner(state, state.spinnerId) };
}

/** Net chips won (positive) or lost (negative) by a player on a spin. */
export const net = (r: SpinResult | undefined) => (r ? r.returned - r.staked : 0);

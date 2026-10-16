/** European single-zero wheel, in order going clockwise seen from above. */
export const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
] as const;
export const POCKETS = WHEEL_ORDER.length; // 37

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export type PocketColor = "red" | "black" | "green";

export function pocketColor(n: number): PocketColor {
  if (n === 0) return "green";
  return RED.has(n) ? "red" : "black";
}

/**
 * Where a bet sits: a single number ("n0".."n36"), or an outside bet.
 * d1..d3 are the dozens (1-12, 13-24, 25-36); c1..c3 the columns
 * (c1 = 1, 4, 7 … 34; c3 = 3, 6, 9 … 36).
 */
export type Spot =
  | `n${number}`
  | "red"
  | "black"
  | "odd"
  | "even"
  | "low"
  | "high"
  | "d1"
  | "d2"
  | "d3"
  | "c1"
  | "c2"
  | "c3";

export const OUTSIDE_SPOTS = ["red", "black", "odd", "even", "low", "high", "d1", "d2", "d3", "c1", "c2", "c3"] as const;

export function isSpot(value: unknown): value is Spot {
  if (typeof value !== "string") return false;
  if ((OUTSIDE_SPOTS as readonly string[]).includes(value)) return true;
  const m = /^n(0|[1-9]\d?)$/.exec(value);
  return !!m && Number(m[1]) <= 36;
}

/** Winnings per chip staked, not counting the stake itself. */
export function payout(spot: Spot): number {
  if (spot.startsWith("n")) return 35;
  if (spot.startsWith("d") || spot.startsWith("c")) return 2;
  return 1;
}

/** Whether `spot` wins when the ball lands on `n`. Zero loses every outside bet. */
export function wins(spot: Spot, n: number): boolean {
  if (spot.startsWith("n")) return Number(spot.slice(1)) === n;
  if (n === 0) return false;
  switch (spot) {
    case "red":
      return RED.has(n);
    case "black":
      return !RED.has(n);
    case "odd":
      return n % 2 === 1;
    case "even":
      return n % 2 === 0;
    case "low":
      return n <= 18;
    case "high":
      return n >= 19;
    case "d1":
    case "d2":
    case "d3":
      return Math.ceil(n / 12) === Number(spot[1]);
    case "c1":
    case "c2":
    case "c3":
      return ((n - 1) % 3) + 1 === Number(spot[1]);
    default:
      return false;
  }
}

/** Total returned to the player (stakes on winning spots plus winnings); 0 if nothing won. */
export function settle(bets: Partial<Record<Spot, number>>, n: number): number {
  let back = 0;
  for (const [spot, amount] of Object.entries(bets) as [Spot, number][]) {
    if (amount > 0 && wins(spot, n)) back += amount * (payout(spot) + 1);
  }
  return back;
}

export const STARTING_CHIPS = 1000;
export const CHIP_VALUES = [5, 25, 100] as const;
export const ROUND_OPTIONS = [5, 10, 20] as const;
export const DEFAULT_ROUNDS = 10;
/** Most chips any one player may have on a single spot. */
export const MAX_SPOT_BET = 1000;

export function spotLabel(spot: Spot): string {
  if (spot.startsWith("n")) return spot.slice(1);
  const labels: Record<string, string> = {
    red: "Red",
    black: "Black",
    odd: "Odd",
    even: "Even",
    low: "1–18",
    high: "19–36",
    d1: "1st 12",
    d2: "2nd 12",
    d3: "3rd 12",
    c1: "Column 1",
    c2: "Column 2",
    c3: "Column 3",
  };
  return labels[spot] ?? spot;
}

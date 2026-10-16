import { describe, expect, it } from "vitest";
import {
  addPlayer,
  applySpin,
  clearBets,
  createGame,
  HISTORY_LIMIT,
  placeBet,
  rematch,
  removePlayer,
  staked,
  startMatch,
  type GameState,
} from "../src/game/roulette";
import { isSpot, OUTSIDE_SPOTS, payout, pocketColor, POCKETS, settle, STARTING_CHIPS, WHEEL_ORDER, wins, type Spot } from "../src/game/rules";

const ALL_SPOTS: Spot[] = [...Array.from({ length: 37 }, (_, n) => `n${n}` as Spot), ...OUTSIDE_SPOTS];

function match(...ids: string[]): GameState {
  let g = createGame(3);
  for (const id of ids) g = addPlayer(g, id);
  return startMatch(g);
}

describe("the wheel", () => {
  it("has every number 0–36 exactly once, alternating red and black after the zero", () => {
    expect([...WHEEL_ORDER].sort((a, b) => a - b)).toEqual(Array.from({ length: 37 }, (_, i) => i));
    expect(POCKETS).toBe(37);
    for (let i = 1; i < POCKETS; i++) expect(pocketColor(WHEEL_ORDER[i])).toBe(i % 2 ? "red" : "black");
    expect(pocketColor(0)).toBe("green");
  });
});

describe("bets", () => {
  it("recognises every spot and nothing else", () => {
    for (const s of ALL_SPOTS) expect(isSpot(s)).toBe(true);
    for (const s of ["n37", "n-1", "n01", "n", "blue", 5, null, "d4", "c0"]) expect(isSpot(s)).toBe(false);
  });

  it("covers the right numbers for each outside bet", () => {
    const covered = (spot: Spot) => Array.from({ length: 37 }, (_, n) => n).filter((n) => wins(spot, n));
    expect(covered("red")).toHaveLength(18);
    expect(covered("black")).toHaveLength(18);
    expect(covered("odd")).toEqual(Array.from({ length: 18 }, (_, i) => i * 2 + 1));
    expect(covered("even")).toEqual(Array.from({ length: 18 }, (_, i) => i * 2 + 2));
    expect(covered("low")).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(covered("d2")).toEqual(Array.from({ length: 12 }, (_, i) => i + 13));
    expect(covered("c1")).toEqual(Array.from({ length: 12 }, (_, i) => i * 3 + 1));
    expect(covered("c3")).toEqual(Array.from({ length: 12 }, (_, i) => i * 3 + 3));
    for (const s of OUTSIDE_SPOTS) expect(wins(s, 0)).toBe(false);
    expect(covered("n0")).toEqual([0]);
  });

  it("gives the house its 1/37 edge on every bet", () => {
    for (const spot of ALL_SPOTS) {
      let back = 0;
      for (let n = 0; n <= 36; n++) back += settle({ [spot]: 1 }, n);
      // Expected return per chip is 36/37 for every European bet.
      expect(back).toBe(36);
    }
    expect(payout("n17")).toBe(35);
    expect(payout("d1")).toBe(2);
    expect(payout("red")).toBe(1);
  });

  it("moves chips from hand to table and back", () => {
    let g = match("a");
    g = placeBet(g, "a", "red", 100);
    g = placeBet(g, "a", "n17", 25);
    expect(g.chips.a).toBe(STARTING_CHIPS - 125);
    expect(staked(g.bets.a)).toBe(125);
    g = placeBet(g, "a", "n17", -25);
    expect(g.bets.a).toEqual({ red: 100 });
    g = clearBets(g, "a");
    expect(g.chips.a).toBe(STARTING_CHIPS);
    expect(g.bets.a).toBeUndefined();
  });

  it("refuses bets it can't take", () => {
    const g = match("a");
    expect(placeBet(g, "a", "red", STARTING_CHIPS + 1)).toBe(g); // more than in hand
    expect(placeBet(g, "a", "red", -5)).toBe(g); // nothing there to take back
    expect(placeBet(g, "a", "red", 2.5)).toBe(g);
    expect(placeBet(g, "zz", "red", 5)).toBe(g); // not a player
    expect(placeBet(createGame(), "a", "red", 5).bets).toEqual({}); // not betting
  });
});

describe("applySpin", () => {
  it("pays winners, clears the table and passes the wheel on", () => {
    let g = match("a", "b");
    g = placeBet(g, "a", "n17", 10);
    g = placeBet(g, "a", "red", 10);
    g = placeBet(g, "b", "black", 50);
    g = applySpin(g, "s1", 17); // 17 is black
    expect(g.chips.a).toBe(STARTING_CHIPS - 20 + 360);
    expect(g.chips.b).toBe(STARTING_CHIPS - 50 + 100);
    expect(g.lastSpin).toMatchObject({ pocket: 17, color: "black", spinner: "a", results: { a: { staked: 20, returned: 360 }, b: { staked: 50, returned: 100 } } });
    expect(g.bets).toEqual({});
    expect(g.spinnerId).toBe("b");
    expect(g.spun).toBe(1);
  });

  it("ends the match after the last spin, most chips winning, ties shared", () => {
    let g = match("a", "b", "c");
    g = applySpin(g, "s1", 1);
    g = applySpin(g, "s2", 2);
    g = placeBet(g, "c", "n0", 5);
    g = applySpin(g, "s3", 3);
    expect(g.phase).toBe("matchOver");
    expect(g.winnerIds).toEqual(["a", "b"]);
  });

  it("caps history and ignores spins outside a match", () => {
    let g = { ...match("a"), rounds: 100 };
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) g = applySpin(g, `s${i}`, i % 37);
    expect(g.history).toHaveLength(HISTORY_LIMIT);
    expect(g.history[0].spinId).toBe(`s${HISTORY_LIMIT + 4}`);
    const lobby = createGame();
    expect(applySpin(lobby, "x", 5)).toBe(lobby);
  });
});

describe("players joining and leaving", () => {
  it("gives late joiners a fresh stack at the end of the turn order", () => {
    const g = addPlayer(match("a", "b"), "c");
    expect(g.turnOrder).toEqual(["a", "b", "c"]);
    expect(g.chips.c).toBe(STARTING_CHIPS);
  });

  it("passes the wheel on when the spinner leaves, and keeps their chips for a rejoin", () => {
    let g = placeBet(match("a", "b", "c"), "a", "red", 100);
    g = removePlayer(g, "a");
    expect(g.spinnerId).toBe("b");
    expect(g.bets.a).toBeUndefined();
    expect(g.chips.a).toBe(STARTING_CHIPS);
    g = addPlayer(g, "a");
    expect(g.chips.a).toBe(STARTING_CHIPS);
  });

  it("resets to the lobby when everyone leaves", () => {
    const g = removePlayer(match("a"), "a");
    expect(g.phase).toBe("lobby");
    expect(g.turnOrder).toEqual([]);
  });

  it("rotates the first spinner on rematch and resets chips", () => {
    let g = match("a", "b");
    g = placeBet(g, "a", "red", 500);
    g = applySpin(applySpin(applySpin(g, "1", 1), "2", 2), "3", 3);
    expect(g.phase).toBe("matchOver");
    g = startMatch(rematch(g));
    expect(g.spinnerId).toBe("b");
    expect(g.chips).toEqual({ a: STARTING_CHIPS, b: STARTING_CHIPS });
    expect(g.spun).toBe(0);
  });
});

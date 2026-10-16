import { describe, expect, it } from "vitest";
import { HostAuthority, randomPocket } from "../src/game/host";
import { STARTING_CHIPS } from "../src/game/rules";
import type { Msg } from "../src/net/protocol";
import { MAX_WHEEL, MIN_WHEEL, spinDurationMs } from "../src/wheel/spin";

const spin = (wheel = 3, ball = 0.5): Msg => ({ t: "spin", input: { wheel, ball, source: "motion" } });

function setup(pocket = 17) {
  let now = 1000;
  let id = 0;
  const host = new HostAuthority({ selfId: "a", now: () => now, newId: () => `spin-${++id}`, pickPocket: () => pocket, newSeed: () => 42 });
  host.join("a", { name: "A" });
  host.join("b", { name: "B" });
  return { host, advance: (ms: number) => (now += ms) };
}

describe("HostAuthority", () => {
  it("assigns distinct colors and increasing join order", () => {
    const { host } = setup();
    const [a, b] = host.players;
    expect(a.color).not.toBe(b.color);
    expect(b.joinedAt).toBeGreaterThan(a.joinedAt);
  });

  it("takes bets from players and settles them on the spin", () => {
    const { host } = setup(17);
    host.start(10);
    host.handle("b", { t: "bet", spot: "n17", amount: 10 });
    host.handle("b", { t: "bet", spot: "nonsense" as never, amount: 10 });
    expect(host.game.bets.b).toEqual({ n17: 10 });
    const [msg] = host.handle("a", spin());
    expect(msg).toMatchObject({ t: "spun", plan: { pocket: 17, spinner: "a", seed: 42 }, landsInMs: spinDurationMs(0.5) });
    expect(host.game.chips.b).toBe(STARTING_CHIPS - 10 + 360);
    expect(host.game.spinnerId).toBe("b");
  });

  it("only lets the spinner spin, and locks the table while the ball rolls", () => {
    const { host, advance } = setup();
    host.start(10);
    expect(host.handle("b", spin())).toEqual([]);
    expect(host.handle("a", spin())).toHaveLength(1);
    expect(host.handle("b", spin())).toEqual([]); // b's turn now, but the ball is still rolling
    expect(host.handle("a", { t: "bet", spot: "red", amount: 5 })).toEqual([]);
    advance(spinDurationMs(0.5));
    expect(host.handle("a", { t: "bet", spot: "red", amount: 5 })).toHaveLength(1);
    expect(host.handle("b", spin())).toHaveLength(1);
  });

  it("clamps the wheel and ball from any client", () => {
    const { host } = setup();
    host.start(10);
    const [msg] = host.handle("a", { t: "spin", input: { wheel: -1e9, ball: Number.NaN, source: "hax" as never } });
    expect(msg.t === "spun" && msg.plan.wheel).toBe(-MAX_WHEEL);
    expect(msg.t === "spun" && msg.plan.ball).toBe(0.6);
    const { host: h2 } = setup();
    h2.start(10);
    const [m2] = h2.handle("a", spin(0.01));
    expect(m2.t === "spun" && m2.plan.wheel).toBe(MIN_WHEEL);
  });

  it("rejects unknown round counts", () => {
    const { host } = setup();
    host.start(7);
    expect(host.game.rounds).toBe(10);
    expect(host.game.phase).toBe("betting");
  });

  it("prunes players who did not reconnect after a migration", () => {
    const { host } = setup();
    host.join("c", { name: "C" });
    host.prune(new Set(["a", "c"]));
    expect(host.players.map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("sanitizes names and avatars", () => {
    const { host } = setup();
    host.join("x", { name: "\u0007" + "y".repeat(50), avatarUrl: "javascript:alert(1)" });
    const x = host.players.find((p) => p.id === "x")!;
    expect(x.name).toBe("y".repeat(24));
    expect(x.avatarUrl).toBeUndefined();
  });

  it("picks every pocket, fairly", () => {
    const counts = new Map<number, number>();
    const N = 37_000;
    for (let i = 0; i < N; i++) {
      const n = randomPocket();
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    expect(counts.size).toBe(37);
    for (const c of counts.values()) expect(Math.abs(c - 1000)).toBeLessThan(160);
  });
});

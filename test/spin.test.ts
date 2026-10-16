import { describe, expect, it } from "vitest";
import { POCKETS, WHEEL_ORDER } from "../src/game/rules";
import { twistWheel, TWIST_NOISE } from "../src/input/motion";
import { BallPath, normalizeSpin, pocketAngle, pocketAt, TRACK, type SpinPlan } from "../src/wheel/spin";

const plan = (over: Partial<SpinPlan> = {}): SpinPlan => ({ spinId: "s", spinner: "a", pocket: 17, wheel: 3, ball: 0.5, seed: 1, ...over });
const TAU = Math.PI * 2;
const mod = (v: number) => ((v % TAU) + TAU) % TAU;

describe("pocket angles", () => {
  it("round-trips every pocket", () => {
    for (const n of WHEEL_ORDER) expect(pocketAt(pocketAngle(n))).toBe(n);
    expect(pocketAt(pocketAngle(32) + (TAU / POCKETS) * 0.4)).toBe(32);
  });
});

describe("BallPath", () => {
  it("lands in the planned pocket from any wheel angle, wheel direction, speed and seed", () => {
    for (const pocket of [0, 17, 26, 32, 5]) {
      for (const wheel0 of [0, 1.3, -4, 100]) {
        for (const wheel of [3, -2.5, 7]) {
          for (const seed of [1, 99, 123456]) {
            const path = new BallPath(plan({ pocket, wheel, seed, ball: (seed % 10) / 10 }), wheel0);
            const end = path.pose(path.duration);
            const rel = mod(end.angle - path.wheelAngle(path.duration));
            expect(pocketAt(rel)).toBe(pocket);
            expect(end.r).toBeCloseTo(TRACK.pocketR);
            // Just before the end it's already settled in (or right next to) that pocket.
            const late = path.pose(path.duration - 0.05);
            expect(pocketAt(mod(late.angle - path.wheelAngle(path.duration - 0.05)))).toBe(pocket);
          }
        }
      }
    }
  });

  it("runs against the wheel, starting on the rim at the launch spot", () => {
    const path = new BallPath(plan({ wheel: 3 }), 0.7);
    const start = path.pose(0);
    expect(start.r).toBe(TRACK.rimR);
    expect(mod(start.angle)).toBeCloseTo(0, 5);
    const a = path.pose(0.5).angle - path.pose(0.4).angle;
    expect(a).toBeLessThan(0); // the wheel turns + (counter-clockwise), the ball −
  });

  it("is the same on every client for the same plan", () => {
    const a = new BallPath(plan({ seed: 7 }), 2);
    const b = new BallPath(plan({ seed: 7 }), 2);
    expect(a.hops).toEqual(b.hops);
    expect(a.pose(5)).toEqual(b.pose(5));
    expect(a.hops.length).toBeGreaterThan(1);
  });
});

describe("normalizeSpin", () => {
  it("survives garbage", () => {
    expect(normalizeSpin(null)).toMatchObject({ wheel: 2.4, ball: 0.6, source: "button" });
    expect(normalizeSpin({ wheel: Infinity, ball: -3 })).toMatchObject({ wheel: 2.4, ball: 0.2 });
  });
});

describe("twistWheel", () => {
  it("ignores small wobbles", () => {
    expect(twistWheel(0, TWIST_NOISE / 2)).toBe(0);
  });

  it("speeds the wheel up when you twist faster than it turns", () => {
    let w = 0;
    for (let i = 0; i < 20; i++) w = twistWheel(w, 400);
    expect(w).toBeGreaterThan(3.5);
    // A slower twist doesn't slow it down.
    expect(twistWheel(w, 100)).toBe(w);
  });

  it("ratchets: twisting back to wind up again doesn't brake the wheel", () => {
    let w = 0;
    for (let i = 0; i < 20; i++) w = twistWheel(w, -400);
    expect(w).toBeLessThan(-3.5);
    expect(twistWheel(w, 500)).toBe(w);
  });
});

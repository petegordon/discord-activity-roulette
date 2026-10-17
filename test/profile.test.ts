import { describe, expect, it } from "vitest";
import { FlickDetector, twistWheel } from "../src/input/motion";
import {
  buildProfile,
  DEFAULT_PROFILE,
  gradeFlick,
  gradeTwist,
  principalAxis,
  StrokeTracker,
  twistRate,
  type Vec3,
} from "../src/input/profile";

describe("grading", () => {
  it("grades twists and flicks against the default profile", () => {
    expect([120, 300, 600].map((p) => gradeTwist(p, DEFAULT_PROFILE))).toEqual(["soft", "good", "strong"]);
    expect([9, 15, 22, 40].map((p) => gradeFlick(p, DEFAULT_PROFILE))).toEqual(["too-soft", "soft", "good", "strong"]);
  });
});

describe("StrokeTracker", () => {
  it("splits a ratchet twist into drive strokes and wind-backs", () => {
    const s = new StrokeTracker();
    const strokes = [];
    for (let i = 0; i < 120; i++) {
      // 0.4 s cycles: a quick 400°/s twist, then a slower 150°/s wind back.
      const ph = (i * 16) % 400;
      const rate = ph < 160 ? 400 * Math.sin((ph / 160) * Math.PI) : -150 * Math.sin(((ph - 160) / 240) * Math.PI);
      const st = s.push(i * 16, rate);
      if (st) strokes.push(st);
    }
    const drive = strokes.filter((x) => x.dir === 1);
    const back = strokes.filter((x) => x.dir === -1);
    expect(drive.length).toBeGreaterThanOrEqual(3);
    expect(back.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...drive.map((x) => x.peak))).toBeGreaterThan(350);
    expect(Math.max(...back.map((x) => x.peak))).toBeLessThan(160);
  });
});

describe("principalAxis", () => {
  it("finds the axis a player twists about, whatever the grip", () => {
    const tilted: Vec3 = [0.6, 0, 0.8];
    const samples: Vec3[] = [];
    for (let i = 0; i < 50; i++) {
      const w = 300 * Math.sin(i / 3);
      samples.push([tilted[0] * w + (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, tilted[2] * w + (Math.random() - 0.5) * 20]);
    }
    const a = principalAxis(samples);
    expect(a[0]).toBeCloseTo(0.6, 1);
    expect(a[2]).toBeCloseTo(0.8, 1);
    expect(twistRate([60, 0, 80], { ...DEFAULT_PROFILE, axis: a })).toBeCloseTo(100, -1);
  });
});

describe("buildProfile", () => {
  const base = { axis: [0, 0, 1] as Vec3, twistAcc: [4, 5, 6], flickTwist: [40, 60, 50] };

  it("makes a gentle player's own twist and flick count as good, and still launch", () => {
    const p = buildProfile({ ...base, twistPeaks: [140, 150, 160, 150, 145], flickPeaks: [10, 11, 9.5, 10.5, 10] });
    expect(gradeTwist(150, p)).toBe("good");
    expect(gradeTwist(80, p)).toBe("soft");
    expect(gradeTwist(260, p)).toBe("strong");
    expect(gradeFlick(10, p)).toBe("good");
    expect(gradeFlick(10, p)).not.toBe("too-soft");
    // Their typical twist spins the wheel well past "ready".
    let w = 0;
    for (let i = 0; i < 40; i++) w = twistWheel(w, 150, p);
    expect(w).toBeGreaterThan(2.5);
  });

  it("keeps a hard twister's twisting jolts from launching the ball", () => {
    const p = buildProfile({ ...base, twistPeaks: [500, 550, 600], twistAcc: [14, 16, 15], flickPeaks: [30, 32, 28] });
    expect(p.flickPeak).toBeGreaterThan(16);
    expect(gradeFlick(30, p)).toBe("good");
  });

  it("raises the twist guard when the player's flick turns the phone about the twist axis", () => {
    // Screen down, flicking the wrist sideways: the flick itself spins the phone ~400°/s.
    const p = buildProfile({ ...base, twistPeaks: [300, 320, 310], flickPeaks: [20, 22, 21], flickTwist: [380, 420, 400] });
    expect(p.twistGuard).toBeGreaterThan(420);
    const d = new FlickDetector(() => p);
    let launched = false;
    for (let t = 0; t < 400; t += 16) {
      const hit = t >= 100 && t < 160;
      const spike = d.push({ t, ax: hit ? 21 : 0, ay: 0, az: 0, rz: hit ? 400 : 0 });
      if (spike?.strength != null) launched = true;
    }
    expect(launched).toBe(true);
  });
});

describe("FlickDetector near misses", () => {
  it("reports a jerk just under the launch threshold without launching", () => {
    const d = new FlickDetector();
    let got = null;
    for (let t = 0; t < 400 && !got; t += 16) got = d.push({ t, ax: t >= 100 && t < 140 ? 9 : 0, ay: 0, az: 0, rz: 0 });
    expect(got).toMatchObject({ strength: null });
    expect(gradeFlick(got!.peak, DEFAULT_PROFILE)).toBe("too-soft");
  });
});

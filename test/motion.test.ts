import { describe, expect, it } from "vitest";
import { FlickDetector, FLICK_PEAK, MotionReader, type MotionSample } from "../src/input/motion";

const HZ = 60;
const dt = 1000 / HZ;

/** Feed samples from `fn(tMs)`; returns the time and strength of the first flick, if any. */
function feed(d: FlickDetector, from: number, to: number, fn: (t: number) => Partial<MotionSample>) {
  for (let t = from; t < to; t += dt) {
    const strength = d.push({ t, ax: 0, ay: 0, az: 0, rz: 0, ...fn(t) });
    if (strength !== null) return { t, strength };
  }
  return null;
}

describe("FlickDetector", () => {
  it("ignores holding the phone and sensor noise", () => {
    expect(feed(new FlickDetector(), 0, 2000, () => ({ ax: (Math.random() - 0.5) * 3, ay: (Math.random() - 0.5) * 3 }))).toBeNull();
  });

  it("launches on a sharp jerk in any direction, without waiting for the phone to go still", () => {
    for (const axis of ["ax", "ay", "az"] as const) {
      const hit = feed(new FlickDetector(), 0, 600, (t) => (t >= 200 && t < 260 ? { [axis]: -20 } : t >= 260 && t < 400 ? { [axis]: 8 } : {}));
      expect(hit).not.toBeNull();
      expect(hit!.t).toBeLessThan(320);
    }
  });

  it("scales strength with how hard the flick is", () => {
    const soft = feed(new FlickDetector(), 0, 500, (t) => (t >= 100 && t < 140 ? { az: FLICK_PEAK + 1 } : {}))!;
    const hard = feed(new FlickDetector(), 0, 500, (t) => (t >= 100 && t < 140 ? { az: 40 } : {}))!;
    expect(soft.strength).toBeLessThan(0.35);
    expect(hard.strength).toBe(1);
  });

  it("doesn't launch while the phone is being twisted hard, or straight after", () => {
    const d = new FlickDetector();
    // Twisting fast with a lot of hand movement.
    expect(feed(d, 0, 1000, (t) => ({ rz: 500, ax: 18 * Math.sin(t / 30) }))).toBeNull();
    // A jerk 50 ms after the twist stops is still part of it…
    expect(feed(d, 1000, 1100, (t) => (t < 1050 ? {} : { ax: 20 }))).toBeNull();
    // …but a flick a moment later counts.
    expect(feed(d, 1300, 1600, (t) => (t >= 1400 && t < 1450 ? { az: -25 } : {}))).not.toBeNull();
  });
});

describe("MotionReader", () => {
  type V = [number, number, number];
  const ev = (acc: V, grav: V) =>
    ({
      acceleration: { x: acc[0], y: acc[1], z: acc[2] },
      accelerationIncludingGravity: { x: acc[0] + grav[0], y: acc[1] + grav[1], z: acc[2] + grav[2] },
      rotationRate: null,
    }) as unknown as DeviceMotionEvent;

  /** A phone held at a typical playing angle, per the spec: gravity reads up the screen and out of it. */
  const held: V = [0, 6.9, 6.9];

  it("passes spec-oriented readings through unchanged", () => {
    const r = new MotionReader();
    for (let i = 0; i < 20; i++) r.read(ev([0, 0, 0], held), i * 16);
    expect(r.sign).toBe(1);
    expect(r.read(ev([3, 0, -2], held), 400)).toMatchObject({ ax: 3, az: -2 });
  });

  it("flips every axis on a device that reports them inverted (iOS Safari)", () => {
    const r = new MotionReader();
    const inverted: V = [0, -6.9, -6.9];
    for (let i = 0; i < 20; i++) r.read(ev([0, 0, 0], inverted), i * 16);
    expect(r.sign).toBe(-1);
    // A push to the right reads as −x there; after the flip it's +x like everywhere else.
    expect(r.read(ev([-3, 0, 2], inverted), 400)).toMatchObject({ ax: 3, az: -2 });
  });

  it("uses screen orientation to find 'up', and keeps its last answer when gravity is ambiguous", () => {
    const r = new MotionReader();
    r.screenAngle = 90; // landscape: device +x is up the screen
    for (let i = 0; i < 20; i++) r.read(ev([0, 0, 0], [-9.6, 0, -1]), i * 16);
    expect(r.sign).toBe(-1);
    for (let i = 0; i < 40; i++) r.read(ev([0, 0, 0], [0, 9.8, -9.8]), 400 + i * 16); // up + out cancel out
    expect(r.sign).toBe(-1);
  });
});

import { DEFAULT_PROFILE, flickStrength, type MotionProfile, type Vec3 } from "./profile";

/** One devicemotion reading in the device frame, gravity removed (m/s²). */
export type MotionSample = {
  /** ms */
  t: number;
  ax: number;
  ay: number;
  az: number;
  /** Rotation rate around the axis out of the screen, deg/s (counter-clockwise +); 0 without a gyroscope. */
  rz?: number;
  /** The whole rotation rate, deg/s: [beta, gamma, alpha] (about the device x, y, z axes). */
  r?: Vec3;
};

/** A jerk at least this hard (m/s², about 1.3 g) launches the ball by default. A gentle wrist flick reaches 15–30. */
export const FLICK_PEAK = DEFAULT_PROFILE.flickPeak;
/** After a spike, keep reading this long to find its peak, then launch. */
const FLICK_PEAK_MS = 80;
/** Twisting faster than the profile's twistGuard isn't a flick, however hard the hand moves… */
/** …and nor is anything this soon after it. */
const TWIST_GUARD_MS = 120;

/** A jerk of the phone: `strength` is set when it was hard enough to launch, null for a near miss. */
export type FlickSpike = { peak: number; strength: number | null };

/** Jerks at least this fraction of the launch threshold are reported as near misses. */
const NEAR_MISS = 0.5;

/**
 * Spots the flick that launches the ball: any sharp jerk of the phone, in any
 * direction (the ball always runs round the track, so only strength matters).
 * Unlike the dice throw, it doesn't wait for the phone to go still or check
 * the direction. Jerks while the phone is being twisted don't count, so
 * spinning the wheel hard can't launch the ball by accident.
 */
export class FlickDetector {
  private lastTwist = -Infinity;
  private spike: { start: number; peak: number } | null = null;

  /** Thresholds come from the player's profile (calibrate.html), read on every sample. */
  constructor(private profile: () => MotionProfile = () => DEFAULT_PROFILE) {}

  reset() {
    this.spike = null;
  }

  /** Feed every sample while holding (with `rz` about the profile's axis); returns each jerk once it has peaked. */
  push(s: MotionSample): FlickSpike | null {
    const p = this.profile();
    if (Math.abs(s.rz ?? 0) >= p.twistGuard) {
      this.lastTwist = s.t;
      this.spike = null;
      return null;
    }
    const m = Math.hypot(s.ax, s.ay, s.az);
    if (!this.spike) {
      if (m >= p.flickPeak * NEAR_MISS && s.t - this.lastTwist > TWIST_GUARD_MS) this.spike = { start: s.t, peak: m };
      return null;
    }
    this.spike.peak = Math.max(this.spike.peak, m);
    if (s.t - this.spike.start < FLICK_PEAK_MS) return null;
    const peak = this.spike.peak;
    this.spike = null;
    return { peak, strength: peak >= p.flickPeak ? flickStrength(peak, p) : null };
  }
}

const rates = (r: DeviceMotionEventRotationRate | null): Vec3 => [r?.beta ?? 0, r?.gamma ?? 0, r?.alpha ?? 0];

/** How much of the gravity estimate is kept per sample when calibrating the sign. */
const CALIBRATION_SMOOTHING = 0.9;
/** Gravity along "up the screen + out of the screen" must be at least this clear (m/s²) to decide the sign. */
const CALIBRATION_MIN = 5;

/**
 * Converts a DeviceMotionEvent into a sample, high-pass filtering gravity out
 * when the browser only provides accelerationIncludingGravity.
 *
 * Some browsers (iOS Safari, at least historically) report every axis with
 * the opposite sign from the spec, which flips left/right and forward/back.
 * Rather than guess from the user agent, the reader calibrates itself:
 * held the way you play, gravity per the spec reads up the screen (+y) and
 * out of it (+z). If it reads the other way, every axis is negated.
 */
export class MotionReader {
  /** +1 for spec axes, −1 for inverted ones. Starts as the spec until gravity says otherwise. */
  sign = 1;
  /** screen.orientation.angle, kept current by the controller. */
  screenAngle = 0;
  private gravity: [number, number, number] | null = null;
  private calibration: [number, number, number] | null = null;

  read(e: DeviceMotionEvent, t: number): MotionSample | null {
    const r = e.rotationRate;
    const rz = r?.alpha ?? 0;
    const g = e.accelerationIncludingGravity;
    const hasG = !!g && g.x !== null && g.y !== null && g.z !== null;
    if (hasG) this.calibrate([g.x!, g.y!, g.z!]);
    const k = this.sign;

    const a = e.acceleration;
    if (a && a.x !== null && a.y !== null && a.z !== null) {
      return { t, ax: k * a.x, ay: k * a.y, az: k * a.z, rz, r: rates(r) };
    }
    if (!hasG) return null;
    const alpha = 0.8;
    const raw: [number, number, number] = [g!.x!, g!.y!, g!.z!];
    this.gravity = this.gravity ? (this.gravity.map((v, i) => alpha * v + (1 - alpha) * raw[i]) as [number, number, number]) : raw;
    return { t, ax: k * (raw[0] - this.gravity[0]), ay: k * (raw[1] - this.gravity[1]), az: k * (raw[2] - this.gravity[2]), rz, r: rates(r) };
  }

  private calibrate(raw: [number, number, number]) {
    const c = CALIBRATION_SMOOTHING;
    this.calibration = this.calibration ? (this.calibration.map((v, i) => c * v + (1 - c) * raw[i]) as [number, number, number]) : raw;
    const [gx, gy, gz] = this.calibration;
    // "Up the screen" in device axes, screen.orientation.angle counter-clockwise.
    const rad = (this.screenAngle * Math.PI) / 180;
    const up = gx * Math.sin(rad) + gy * Math.cos(rad);
    const s = up + gz;
    if (Math.abs(s) >= CALIBRATION_MIN) this.sign = s > 0 ? 1 : -1;
  }
}

/** Twisting slower than this (deg/s) is just holding the phone (by default; see MotionProfile). */
export const TWIST_NOISE = DEFAULT_PROFILE.twistNoise;

/** Slower than this (rad/s), a twist either way can set the wheel's direction. */
const STOPPED = 0.4;

/**
 * Turns the phone's twist into the wheel's speed, like cranking a ratchet:
 * twisting faster than the wheel turns speeds it up; twisting back the other
 * way (to wind up for another twist) is ignored while the wheel is moving, so
 * repeated twists build speed. Otherwise the wheel coasts on its own.
 * `wheel` is in rad/s, counter-clockwise positive.
 */
export function twistWheel(wheel: number, rzDegPerSec: number, p: MotionProfile = DEFAULT_PROFILE): number {
  if (Math.abs(rzDegPerSec) < p.twistNoise) return wheel;
  const target = ((rzDegPerSec * Math.PI) / 180) * p.twistGain;
  if (Math.abs(wheel) > STOPPED && Math.sign(target) !== Math.sign(wheel)) return wheel;
  if (Math.abs(target) <= Math.abs(wheel)) return wheel;
  return wheel + (target - wheel) * 0.25;
}

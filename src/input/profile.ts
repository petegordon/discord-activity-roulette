/**
 * How one player twists and flicks, learned on the calibrate page
 * (calibrate.html) and kept on their phone. The game, the phone remote and
 * the practice page all read it, so a calibrated phone spins the way its
 * owner moves. Without calibration, DEFAULT_PROFILE is the tuned default.
 */

export type Vec3 = [number, number, number];

/** How a twist or flick felt. "too-soft" is a flick that didn't launch. */
export type Grade = "too-soft" | "soft" | "good" | "strong";

export type MotionProfile = {
  version: 1;
  calibrated: boolean;
  /**
   * The axis the player twists around, as a unit vector in the device's
   * rotation-rate frame (x = rotationRate.beta, y = gamma, z = alpha).
   * Default: out of the screen.
   */
  axis: Vec3;
  /** Phone twist (rad/s) per rad/s of wheel. */
  twistGain: number;
  /** Twisting slower than this (deg/s) is just holding the phone. */
  twistNoise: number;
  /** Twisting faster than this (deg/s) means jerks are part of the twist, not a flick. */
  twistGuard: number;
  /** A twist peaking below this (deg/s) is soft; at or above `twistStrong`, strong. */
  twistSoft: number;
  twistStrong: number;
  /** A jerk this hard (m/s²) launches the ball. */
  flickPeak: number;
  /** Flick grades (m/s²): below `flickGood` soft, from `flickStrong` strong. */
  flickGood: number;
  flickStrong: number;
  /** A flick this hard (m/s²) launches at full strength. */
  fullFlick: number;
  /** What calibration saw, for the summary. */
  typical?: { twist: number; flick: number; twistAcc: number; flickTwist: number };
};

export const DEFAULT_PROFILE: MotionProfile = {
  version: 1,
  calibrated: false,
  axis: [0, 0, 1],
  twistGain: 0.6,
  twistNoise: 40,
  twistGuard: 250,
  twistSoft: 200,
  twistStrong: 450,
  flickPeak: 13,
  flickGood: 18,
  flickStrong: 28,
  fullFlick: 35,
};

const KEY = "roulette.motionProfile";

export function loadProfile(): MotionProfile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PROFILE;
    const p = JSON.parse(raw) as MotionProfile;
    return valid(p) ? p : DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
}

export function saveProfile(p: MotionProfile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // storage unavailable: it still applies until the page closes
  }
}

export function clearProfile() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable
  }
}

function valid(p: MotionProfile): boolean {
  const nums = [p.twistGain, p.twistNoise, p.twistGuard, p.twistSoft, p.twistStrong, p.flickPeak, p.flickGood, p.flickStrong, p.fullFlick];
  return (
    p?.version === 1 &&
    Array.isArray(p.axis) &&
    p.axis.length === 3 &&
    [...p.axis, ...nums].every((v) => typeof v === "number" && Number.isFinite(v)) &&
    nums.every((v) => v > 0) &&
    p.fullFlick > p.flickPeak
  );
}

/** Rotation rate (deg/s) about the player's twist axis. */
export function twistRate(rate: Vec3, p: MotionProfile): number {
  return rate[0] * p.axis[0] + rate[1] * p.axis[1] + rate[2] * p.axis[2];
}

export function gradeTwist(peak: number, p: MotionProfile): Exclude<Grade, "too-soft"> {
  return peak < p.twistSoft ? "soft" : peak >= p.twistStrong ? "strong" : "good";
}

export function gradeFlick(peak: number, p: MotionProfile): Grade {
  if (peak < p.flickPeak) return "too-soft";
  return peak < p.flickGood ? "soft" : peak >= p.flickStrong ? "strong" : "good";
}

/** Launch strength 0.25..1 of a flick that peaked at `peak`. */
export function flickStrength(peak: number, p: MotionProfile): number {
  const k = Math.min(1, Math.max(0, (peak - p.flickPeak) / (p.fullFlick - p.flickPeak)));
  return 0.25 + 0.75 * k;
}

/** One twist stroke: a burst of turning one way. */
export type Stroke = { peak: number; dir: 1 | -1; ms: number; acc: number };

/**
 * Splits the twist rate into strokes. A stroke starts when the rate passes
 * `noise` and ends when it falls back under half that or reverses.
 */
export class StrokeTracker {
  private cur: { dir: 1 | -1; start: number; peak: number; acc: number } | null = null;

  constructor(private noise = () => DEFAULT_PROFILE.twistNoise) {}

  reset() {
    this.cur = null;
  }

  /** `rate` deg/s about the twist axis, `acc` the jerk (m/s²) at the time. Returns a stroke as it ends. */
  push(t: number, rate: number, acc = 0): Stroke | null {
    const noise = this.noise();
    const dir: 1 | -1 = rate >= 0 ? 1 : -1;
    const mag = Math.abs(rate);
    let done: Stroke | null = null;
    if (this.cur && (mag < noise / 2 || dir !== this.cur.dir)) {
      const ms = t - this.cur.start;
      if (ms >= 40) done = { peak: this.cur.peak, dir: this.cur.dir, ms, acc: this.cur.acc };
      this.cur = null;
    }
    if (this.cur) {
      this.cur.peak = Math.max(this.cur.peak, mag);
      this.cur.acc = Math.max(this.cur.acc, acc);
    } else if (mag >= noise) {
      this.cur = { dir, start: t, peak: mag, acc };
    }
    return done;
  }
}

/** The main axis of a set of rotation-rate vectors (sign-free), by power iteration on Σ v·vᵀ. */
export function principalAxis(samples: Vec3[], seed: Vec3 = [0, 0, 1]): Vec3 {
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const v of samples) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] += v[i] * v[j];
  let a: Vec3 = [...seed];
  for (let k = 0; k < 30; k++) {
    const b: Vec3 = [0, 1, 2].map((i) => m[i * 3] * a[0] + m[i * 3 + 1] * a[1] + m[i * 3 + 2] * a[2]) as Vec3;
    const n = Math.hypot(...b);
    if (n === 0) return seed;
    a = b.map((x) => x / n) as Vec3;
  }
  // Keep it pointing the way of the seed (out of the screen, by default), so twist directions stay familiar.
  const d = a[0] * seed[0] + a[1] * seed[1] + a[2] * seed[2];
  return d < 0 ? (a.map((x) => -x) as Vec3) : a;
}

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? 0 : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** A typical twist should drive the wheel to about this (rad/s): a lively spin, well past WHEEL_READY. */
const TARGET_WHEEL = 3.2;

export type CalibrationData = {
  axis: Vec3;
  /** Peaks (deg/s about `axis`) of the strokes that drive the wheel. */
  twistPeaks: number[];
  /** Hardest jerk (m/s²) during each of those strokes. */
  twistAcc: number[];
  /** Peak jerk (m/s²) of each flick. */
  flickPeaks: number[];
  /** Fastest turn about `axis` (deg/s) during each flick. */
  flickTwist: number[];
};

/**
 * A profile fitted to how this player moves: their typical twist counts as
 * "good" and spins the wheel nicely; their typical flick counts as "good"
 * and launches with room to spare, and still stands clear of the jolts
 * their twisting makes.
 */
export function buildProfile(d: CalibrationData): MotionProfile {
  const tp = median(d.twistPeaks);
  const fm = median(d.flickPeaks);
  const twistAcc = Math.max(0, ...d.twistAcc.slice().sort((a, b) => a - b).slice(0, Math.ceil(d.twistAcc.length * 0.9)));
  const flickTwist = median(d.flickTwist);

  const twistNoise = clamp(tp * 0.15, 25, 70);
  let twistGuard = clamp(tp * 0.55, 150, 500);
  let flickPeak = clamp(fm * 0.55, 8, 22);
  // Twisting jolts the phone too: keep the launch threshold above those jolts where the flicks allow it.
  if (twistAcc * 1.15 > flickPeak) flickPeak = Math.min(twistAcc * 1.15, fm * 0.85);
  // A wrist flick can turn the phone about the twist axis as well; don't let the guard swallow it.
  if (flickTwist > twistGuard * 0.8) twistGuard = Math.max(twistGuard, flickTwist * 1.25);

  return {
    version: 1,
    calibrated: true,
    axis: d.axis,
    twistGain: clamp(TARGET_WHEEL / ((tp * Math.PI) / 180), 0.25, 1.6),
    twistNoise,
    twistGuard,
    twistSoft: tp * 0.7,
    twistStrong: tp * 1.35,
    flickPeak,
    flickGood: Math.max(flickPeak + 1, fm * 0.8),
    flickStrong: Math.max(flickPeak + 3, fm * 1.3),
    fullFlick: Math.max(flickPeak + 6, fm * 1.35),
    typical: { twist: tp, flick: fm, twistAcc, flickTwist },
  };
}

import { POCKETS, WHEEL_ORDER } from "../game/rules";

/**
 * A spin gesture, already reduced to two numbers. See input/controller.ts.
 * `wheel` is the wheel's angular velocity when the ball was launched (rad/s;
 * positive is counter-clockwise seen from above); `ball` is launch strength.
 */
export type SpinInput = {
  wheel: number;
  /** 0..1 */
  ball: number;
  source: "motion" | "flick" | "button";
};

export type SpinPlan = {
  spinId: string;
  spinner: string;
  /** The number the ball lands on, picked by the host. */
  pocket: number;
  /** rad/s, signed. */
  wheel: number;
  /** 0..1 */
  ball: number;
  /** Seeds the bounces, so every client draws the same ones. */
  seed: number;
};

export const MIN_WHEEL = 1.2;
export const MAX_WHEEL = 7;
/** Below this, the wheel isn't really spinning and a flick can't launch the ball. */
export const WHEEL_READY = 1.0;
const MIN_BALL = 0.2;

/** Wheel friction: ω(t) = ω0·e^(−k·t). Real wheels coast for a minute or more. */
export const WHEEL_FRICTION = 0.035;

/** Where things are on the wheel (world units; the wheel is centred on the origin). */
export const TRACK = {
  /** Ball track on the rim, where the ball circles. */
  rimR: 3.05,
  rimY: 0.745,
  /** Bottom of the pockets. */
  pocketR: 1.95,
  pocketY: 0.16,
  ballR: 0.11,
};

/** The ball is launched from the side nearest the camera (+z). */
export const LAUNCH_ANGLE = 0;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const TAU = Math.PI * 2;
const mod = (v: number, m: number) => ((v % m) + m) % m;

/** Sanitises a spin from any client. Runs on the host, so it must tolerate arbitrary input. */
export function normalizeSpin(input: Partial<SpinInput> | null | undefined): SpinInput {
  const raw = finite(input?.wheel, MIN_WHEEL * 2);
  const sign = raw < 0 ? -1 : 1;
  const source = input?.source === "motion" || input?.source === "flick" ? input.source : "button";
  return {
    wheel: sign * clamp(Math.abs(raw), MIN_WHEEL, MAX_WHEEL),
    ball: clamp(finite(input?.ball, 0.6), MIN_BALL, 1),
    source,
  };
}

/** A pleasant randomised spin for the Quick spin button. */
export function buttonSpin(rand: () => number = Math.random): SpinInput {
  return normalizeSpin({ wheel: 2.5 + rand() * 2.5, ball: 0.45 + rand() * 0.45, source: "button" });
}

/** How long from launch until the ball comes to rest in its pocket. */
export function spinDurationMs(ball: number): number {
  return Math.round(7000 + clamp(ball, 0, 1) * 2500);
}

/** Wheel angle `t` seconds after it had angular velocity `w0`, starting from 0. */
export function wheelTravel(w0: number, t: number): number {
  return (w0 * (1 - Math.exp(-WHEEL_FRICTION * t))) / WHEEL_FRICTION;
}

export function wheelSpeedAt(w0: number, t: number): number {
  return w0 * Math.exp(-WHEEL_FRICTION * t);
}

/**
 * Angle of a pocket's centre in the wheel's own frame. Positions use
 * (r·sin a, y, r·cos a), so rotating the wheel by θ about +Y adds θ to a.
 * WHEEL_ORDER runs clockwise seen from above, so the angles decrease.
 */
export function pocketAngle(n: number): number {
  const i = WHEEL_ORDER.indexOf(n as (typeof WHEEL_ORDER)[number]);
  return -(Math.max(0, i) * TAU) / POCKETS;
}

/** The pocket under wheel-frame angle `a`. */
export function pocketAt(a: number): number {
  const i = Math.round(mod(-a, TAU) / (TAU / POCKETS)) % POCKETS;
  return WHEEL_ORDER[i];
}

/** mulberry32 */
export function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type BallPose = {
  /** World angle around the wheel (same convention as pocketAngle). */
  angle: number;
  r: number;
  y: number;
};

export type Hop = { t: number; strength: number };

/**
 * The ball's path for one spin, computed the same way on every client. The
 * path is worked out relative to the wheel: the ball laps the wheel against
 * its spin, slows, drops off the rim, rattles over a few frets and settles
 * into `plan.pocket`. Because it's relative, it lands in the right pocket
 * whatever angle this client's wheel happened to be at.
 */
export class BallPath {
  readonly duration: number;
  readonly hops: Hop[];
  private readonly psiEnd: number;
  private readonly travel: number;
  private readonly dir: number;
  private readonly dropAt: number;
  private readonly landAt: number;
  private readonly wobble: number;
  private readonly wobbleFreq: number;
  /** When the ball stops travelling relative to the wheel (bar the final rattle). */
  private readonly settleAt: number;

  /** `wheel0`: this client's wheel angle when the ball is launched. */
  constructor(
    readonly plan: SpinPlan,
    readonly wheel0: number,
  ) {
    const rand = seeded(plan.seed);
    this.duration = spinDurationMs(plan.ball) / 1000;
    const T = this.duration;
    this.dir = plan.wheel >= 0 ? -1 : 1; // the ball runs against the wheel
    this.psiEnd = pocketAngle(plan.pocket);
    const psi0 = LAUNCH_ANGLE - wheel0;
    const laps = 5 + Math.round(plan.ball * 4);
    this.travel = laps * TAU + mod(this.dir * (this.psiEnd - psi0), TAU);
    this.dropAt = T * (0.58 + rand() * 0.06);
    this.landAt = T * (0.74 + rand() * 0.05);
    // Overshoot by up to a couple of pockets, either way, then rock back.
    this.wobble = (rand() < 0.5 ? -1 : 1) * (0.6 + rand() * 1.4) * (TAU / POCKETS);
    this.wobbleFreq = 0.9 + rand() * 0.6;
    this.settleAt = this.landAt + 0.4;
    const hops: Hop[] = [];
    const count = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      const u = i / count;
      hops.push({ t: this.dropAt + (this.landAt - this.dropAt) * 0.35 + (T - this.dropAt) * 0.55 * u * u + rand() * 0.08, strength: 1 - u * 0.7 });
    }
    this.hops = hops.filter((h) => h.t < T - 0.3);
  }

  /** Wheel angle on this client, `t` seconds after launch. */
  wheelAngle(t: number): number {
    return this.wheel0 + wheelTravel(this.plan.wheel, Math.max(0, t));
  }

  /** Ball position relative to the wheel, as an angle in the wheel's frame. */
  relativeAngle(t: number): number {
    const T = this.duration;
    if (t >= T) return this.psiEnd;
    const u = clamp(t / this.settleAt, 0, 1);
    const f = (1 - u) ** 2;
    let psi = this.psiEnd - this.dir * this.travel * f;
    if (t > this.landAt) {
      const s = t - this.landAt;
      const ramp = Math.min(1, s / 0.25);
      psi += this.wobble * ramp * Math.exp(-s * 3.2) * Math.sin(TAU * this.wobbleFreq * s);
    }
    return psi;
  }

  pose(t: number): BallPose {
    const { rimR, rimY, pocketR, pocketY } = TRACK;
    const angle = this.wheelAngle(t) + this.relativeAngle(t);
    if (t <= this.dropAt) return { angle, r: rimR, y: rimY };
    if (t >= this.duration) return { angle, r: pocketR, y: pocketY };
    // Spiral down the cone, hopping as it hits the frets.
    const k = clamp((t - this.dropAt) / (this.landAt - this.dropAt), 0, 1);
    const ease = k * k * (3 - 2 * k);
    let r = rimR + (pocketR - rimR) * ease;
    let y = rimY + (pocketY - rimY) * ease;
    for (const hop of this.hops) {
      const dt = t - hop.t;
      const len = 0.18 + 0.12 * hop.strength;
      if (dt > 0 && dt < len) {
        const h = Math.sin((dt / len) * Math.PI);
        y += h * 0.32 * hop.strength;
        r += h * 0.18 * hop.strength;
      }
    }
    return { angle, r: Math.min(r, rimR), y };
  }

  /** The ball's speed along the track, for the rolling sound (rad/s, absolute). */
  speed(t: number): number {
    const dt = 1 / 60;
    let d = this.wheelAngle(t + dt) + this.relativeAngle(t + dt) - (this.wheelAngle(t) + this.relativeAngle(t));
    d = Math.abs(d) / dt;
    return d;
  }
}

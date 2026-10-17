/** One raw devicemotion reading, as the practice coach sees it. */
export type CoachSample = {
  /** ms */
  t: number;
  /** Rotation about the axis out of the screen (the twist), deg/s. */
  alpha: number;
  /** The larger of the other two rotation rates (tipping the phone), deg/s. */
  tilt: number;
  /** Acceleration without gravity, m/s². */
  acc: number;
};

/**
 * What's going wrong when the wheel won't speed up:
 * - "axis": turning the phone, but about the wrong axis (tipping it rather than dialling it)
 * - "shake": moving it hard without turning it
 * - "faster": turning it the right way, too gently
 */
export type TwistTip = "axis" | "shake" | "faster";

/** How far back the coach looks. */
export const COACH_WINDOW_MS = 1500;
/** A dial-twist (deg/s) that clearly speeds the wheel up. */
const GOOD_TWIST = 200;

/**
 * Reads the last COACH_WINDOW_MS of motion while the player is trying to
 * twist and the wheel isn't getting there. Returns the most useful tip, or
 * null when the twist looks fine (or there's too little to go on).
 */
export function twistTip(samples: CoachSample[], now: number): TwistTip | null {
  const recent = samples.filter((s) => now - s.t <= COACH_WINDOW_MS);
  if (recent.length < 10) return null;
  let alpha = 0;
  let tilt = 0;
  let acc = 0;
  for (const s of recent) {
    alpha = Math.max(alpha, Math.abs(s.alpha));
    tilt = Math.max(tilt, Math.abs(s.tilt));
    acc = Math.max(acc, s.acc);
  }
  if (alpha >= GOOD_TWIST) return null;
  if (tilt >= 150 && tilt > alpha * 1.8) return "axis";
  if (acc >= 12 && alpha < 120) return "shake";
  return "faster";
}

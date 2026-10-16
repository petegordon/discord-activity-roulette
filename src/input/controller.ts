import { motionEnv, motionVerdict } from "../platform/capabilities";
import { inDiscord } from "../platform/env";
import { MAX_WHEEL, normalizeSpin, WHEEL_FRICTION, WHEEL_READY, type SpinInput } from "../wheel/spin";
import { FlickDetector, MotionReader, twistWheel } from "./motion";

/** "blocked": the browser forbids motion in this frame (Discord); "unavailable": no sensors or permission. */
export type MotionState = "unknown" | "needs-permission" | "active" | "blocked" | "unavailable";

/** The two steps of a spin: get the wheel turning, then launch the ball. */
export type SpinStep = "twist" | "flick";

export type ControllerCallbacks = {
  /** The wheel's angular velocity (rad/s), ~15 Hz while it's turning. */
  onWheel: (rate: number) => void;
  onLaunch: (input: SpinInput) => void;
  onHint: (text: string) => void;
  onHoldChange: (holding: boolean) => void;
  onMotionState: (state: MotionState) => void;
  /** The wheel crossed WHEEL_READY: time to flick (or it slowed down again). */
  onStep: (step: SpinStep) => void;
};

const TICK_MS = 66;
const FLICK_WINDOW_MS = 100;
const MIN_FLICK_SPEED = 0.45; // px/ms
const FULL_FLICK_SPEED = 2.6; // px/ms
/** Pointer drag (px/ms, sideways) that reads as one rad/s of wheel. */
const DRAG_GAIN = 2.2;

type PointerSample = { t: number; x: number; y: number };

type DeviceMotionEventIOS = typeof DeviceMotionEvent & { requestPermission?: () => Promise<"granted" | "denied"> };

const clampWheel = (w: number) => Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, w));

/**
 * The spinner's input on the "spin" zone. With device motion: hold, twist
 * the phone like a dial to spin the wheel, then flick it to launch the ball.
 * Without: hold and drag sideways to spin the wheel, then flick upward.
 *
 * The wheel's speed lives here while it's this player's turn; it coasts
 * down with the same friction the scene uses.
 */
export class SpinController {
  motion: MotionState = "unknown";
  /** rad/s, counter-clockwise positive. */
  wheel = 0;
  private enabled = false;
  private holding = false;
  private pointerId: number | null = null;
  private flick = new FlickDetector();
  private reader = new MotionReader();
  private pointer: PointerSample[] = [];
  private tick: ReturnType<typeof setInterval> | undefined;
  private lastTick = 0;
  private lastSentWheel = 0;
  private step: SpinStep = "twist";
  /** The player has sped the wheel up themselves this turn; a coasting wheel isn't a spin. */
  private twisted = false;
  private listening = false;

  constructor(
    private readonly zone: HTMLElement,
    private readonly cb: ControllerCallbacks,
  ) {
    zone.addEventListener("pointerdown", (e) => this.down(e));
    zone.addEventListener("pointermove", (e) => this.move(e));
    zone.addEventListener("pointerup", (e) => this.up(e));
    zone.addEventListener("pointercancel", () => this.endHold());
    zone.addEventListener("contextmenu", (e) => e.preventDefault());

    const verdict = motionVerdict(motionEnv(inDiscord));
    if (verdict === "probe") this.listen();
    else this.setMotion(verdict);
  }

  /** No motion here, and none coming: blocked, missing, or denied. */
  get motionOff() {
    return this.motion === "blocked" || this.motion === "unavailable";
  }

  get currentStep() {
    return this.step;
  }

  /** Twisted this turn and turning fast enough: a flick can launch the ball. */
  private get ready() {
    return this.twisted && Math.abs(this.wheel) >= WHEEL_READY;
  }

  /** Set the wheel from the player's own twist or drag. */
  private push(wheel: number) {
    const next = clampWheel(wheel);
    if (Math.abs(next) > Math.abs(this.wheel) + 1e-3) this.twisted = true;
    this.wheel = next;
  }

  /**
   * On at the start of this player's turn, off otherwise. Turning on picks
   * the wheel up at `wheel` (whatever it's doing on screen).
   */
  setEnabled(enabled: boolean, wheel = this.wheel) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.endHold();
      clearInterval(this.tick);
      this.tick = undefined;
      return;
    }
    this.wheel = wheel;
    this.lastSentWheel = wheel;
    this.twisted = false;
    this.setStep("twist", true);
    this.lastTick = performance.now();
    this.tick = setInterval(() => this.onTick(), TICK_MS);
  }

  /** Must be called from a user gesture (iOS). */
  async requestMotionPermission(): Promise<boolean> {
    const req = (DeviceMotionEvent as DeviceMotionEventIOS).requestPermission;
    if (!req) return this.motion === "active";
    try {
      const result = await req.call(DeviceMotionEvent);
      if (result === "granted") {
        this.listen();
        return true;
      }
    } catch {
      // Rejected, or not allowed in this frame.
    }
    this.setMotion("unavailable");
    return false;
  }

  private setMotion(state: MotionState) {
    if (this.motion === state) return;
    this.motion = state;
    this.cb.onMotionState(state);
  }

  private setStep(step: SpinStep, force = false) {
    if (step === this.step && !force) return;
    this.step = step;
    this.cb.onStep(step);
  }

  private listen() {
    if (this.listening) return;
    this.listening = true;
    // Desktop browsers expose DeviceMotionEvent but never fire it; real sensors report within ~1s.
    const timeout = setTimeout(() => this.motion !== "active" && this.setMotion("unavailable"), 1500);
    window.addEventListener("devicemotion", (e) => {
      const angle = screen.orientation?.angle ?? 0;
      this.reader.screenAngle = angle;
      const sample = this.reader.read(e, performance.now());
      if (!sample) return;
      if (this.motion !== "active") {
        clearTimeout(timeout);
        this.setMotion("active");
      }
      if (!this.holding) return;
      this.push(twistWheel(this.wheel, sample.rz ?? 0));
      const strength = this.flick.push(sample);
      if (strength !== null) this.flicked(strength, "motion");
    });
  }

  private down(e: PointerEvent) {
    if (!this.enabled || this.holding) return;
    e.preventDefault();
    this.holding = true;
    this.pointerId = e.pointerId;
    this.zone.setPointerCapture(e.pointerId);
    this.flick.reset();
    this.pointer = [{ t: e.timeStamp, x: e.clientX, y: e.clientY }];
    this.cb.onHoldChange(true);
  }

  private move(e: PointerEvent) {
    if (!this.holding || e.pointerId !== this.pointerId) return;
    const prev = this.pointer[this.pointer.length - 1];
    const now = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    this.pointer.push(now);
    while (this.pointer.length > 2 && now.t - this.pointer[0].t > 400) this.pointer.shift();
    if (this.motion === "active") return;
    // Dragging sideways pushes the wheel's rim, the way you'd spin it by hand.
    const dt = Math.max(1, now.t - prev.t);
    const vx = (now.x - prev.x) / dt;
    const vy = (now.y - prev.y) / dt;
    if (Math.abs(vx) > Math.abs(vy)) {
      // Dragging right turns the near rim right: clockwise from above.
      const target = clampWheel(-vx * DRAG_GAIN);
      const sameWay = Math.sign(target) === Math.sign(this.wheel) || Math.abs(this.wheel) < 0.4;
      if (sameWay && Math.abs(target) > Math.abs(this.wheel)) this.push(this.wheel + (target - this.wheel) * 0.35);
    }
  }

  private onTick() {
    const now = performance.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    this.wheel *= Math.exp(-WHEEL_FRICTION * dt);
    if (Math.abs(this.wheel) < 0.02) this.wheel = 0;
    if (this.wheel !== this.lastSentWheel) {
      this.lastSentWheel = this.wheel;
      this.cb.onWheel(this.wheel);
    }
    this.setStep(this.ready ? "flick" : "twist");
  }

  private up(e: PointerEvent) {
    if (!this.holding || e.pointerId !== this.pointerId) return;
    const flick = this.motion === "active" ? null : this.pointerFlick(e.timeStamp);
    if (flick !== null) {
      this.flicked(flick, "flick");
      return;
    }
    this.endHold();
    if (this.ready) {
      this.cb.onHint(this.motion === "active" ? "Hold and flick your phone to launch the ball!" : "Now flick upward to launch the ball!");
    } else {
      this.cb.onHint(this.motion === "active" ? "Hold and twist your phone to spin the wheel" : "Hold and drag sideways to spin the wheel");
    }
  }

  /** Launch strength 0..1 of an upward flick at the end of the hold, or null if it wasn't one. */
  private pointerFlick(t: number): number | null {
    let recent = this.pointer.filter((p) => t - p.t <= FLICK_WINDOW_MS);
    // A slow device may deliver pointer events further apart than the window;
    // fall back to the last two samples if the final one is fresh.
    const last2 = this.pointer.slice(-2);
    if (recent.length < 2 && last2.length === 2 && t - last2[1].t <= FLICK_WINDOW_MS) recent = last2;
    if (recent.length < 2) return null;
    const a = recent[0];
    const b = recent[recent.length - 1];
    const dt = Math.max(1, b.t - a.t);
    const vx = (b.x - a.x) / dt;
    const vy = (a.y - b.y) / dt; // screen up = forward
    if (vy < MIN_FLICK_SPEED || vy < Math.abs(vx)) return null;
    return Math.min(1, Math.hypot(vx, vy) / FULL_FLICK_SPEED);
  }

  private flicked(strength: number, source: SpinInput["source"]) {
    if (!this.holding) return;
    if (!this.ready) {
      // Keep holding: a jerk while getting the wheel going shouldn't cost you the grip.
      this.cb.onHint(this.motion === "active" ? "Spin the wheel first: twist your phone" : "Spin the wheel first: drag sideways");
      if (source !== "motion") this.endHold();
      return;
    }
    this.endHold();
    if ("vibrate" in navigator) navigator.vibrate(40);
    this.cb.onLaunch(normalizeSpin({ wheel: this.wheel, ball: strength, source }));
  }

  private endHold() {
    if (!this.holding) return;
    this.holding = false;
    if (this.pointerId !== null && this.zone.hasPointerCapture(this.pointerId)) this.zone.releasePointerCapture(this.pointerId);
    this.pointerId = null;
    this.flick.reset();
    this.cb.onHoldChange(false);
  }
}

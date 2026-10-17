import "../remote/remote.css";
import "../practice/demo.css";
import "../practice/practice.css";
import "./calibrate.css";
import { WheelAudio } from "../audio";
import { pocketColor, POCKETS } from "../game/rules";
import { SpinController } from "../input/controller";
import { MotionReader, twistWheel } from "../input/motion";
import {
  buildProfile,
  clearProfile,
  DEFAULT_PROFILE,
  gradeFlick,
  gradeTwist,
  loadProfile,
  principalAxis,
  saveProfile,
  StrokeTracker,
  twistRate,
  type MotionProfile,
  type Vec3,
} from "../input/profile";
import { Demo } from "../practice/demo";
import { judge } from "../practice/feedback";
import { backLinks } from "../practice/links";
import { Voice } from "../practice/voice";
import { WheelScene } from "../render/scene";
import type { SpinInput, SpinPlan } from "../wheel/spin";

/**
 * Calibrate: the player shows us how they twist and how they flick, we judge
 * each move out loud against the defaults, then fit a MotionProfile to them
 * (profile.ts) and save it on the phone. The game, the phone remote and the
 * practice page all pick it up. Then a try-out spin, judged against the
 * new profile. Nothing here talks to a room.
 */

type Step = "hold" | "twist" | "flick" | "try";
const ORDER: Step[] = ["hold", "twist", "flick", "try"];
const TWISTS = 6;
const FLICKS = 5;
const HOLD_MS = 900;
/** Turning slower than this (deg/s) doesn't tell us about the twist axis. */
const AXIS_MIN = 60;
/** A twist stroke this gentle (deg/s) is too small to count. */
const STROKE_MIN = 80;
/** A jerk this hard (m/s²) counts as a flick while calibrating, however soft it would be in the game. */
const FLICK_MIN = 7;
/** Read a flick's peak over this long. */
const FLICK_PEAK_MS = 120;
/** After a flick, ignore the arm coming back for this long. */
const FLICK_REST_MS = 650;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const NUMBERS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

const COPY: Record<Step, { title: string; body: string; say: string }> = {
  hold: {
    title: "1 · Hold it like the game",
    body: "Thumb on the pad, then turn the phone so the screen faces the floor, the way you'll hold it at the table. Keep your thumb down while I watch.",
    say: "Thumb on the pad, then hold the phone the way you will in the game.",
  },
  twist: {
    title: "2 · Show me your twist",
    body: `Twist the way you'd spin the wheel, ${TWISTS} times, with a short pause between. Just your normal twist; I'll call each one soft, good or strong.`,
    say: `Show me your twist. Twist the way you'd spin the wheel, ${TWISTS} times.`,
  },
  flick: {
    title: "3 · Show me your flick",
    body: `Now throw the ball the way you would: hand out to the right, snap the wrist. ${FLICKS} flicks, with a pause between. Don't twist first.`,
    say: `Now show me your flick, the way you'd throw the ball. ${FLICKS} times, with a pause between.`,
  },
  try: {
    title: "4 · Try a spin",
    body: "Your settings are on. Twist until the chime, then throw. Each move is judged against how you move now.",
    say: "Now try a spin with your settings. Twist until the chime, then throw.",
  },
};

function boot() {
  const audio = new WheelAudio();
  const voice = new Voice();
  const scene = new WheelScene($("stage"));
  const zone = $("zone");
  const reader = new MotionReader();
  const demo = new Demo($("p-demo"), audio, () => holding);

  let step: Step = "hold";
  let started = false;
  let holding = false;
  let pointerId: number | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let spinning = false;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;

  // What we've seen.
  let axis: Vec3 = [0, 0, 1];
  let driveDir: 1 | -1 | 0 = 0;
  let previewWheel = 0;
  const rotations: Vec3[] = [];
  const twistPeaks: number[] = [];
  const twistAcc: number[] = [];
  const flickPeaks: number[] = [];
  const flickTwist: number[] = [];
  const strokes = new StrokeTracker(() => DEFAULT_PROFILE.twistNoise);
  let spike: { start: number; peak: number; twist: number } | null = null;
  let restUntil = 0;
  let profile: MotionProfile | null = null;

  const hint = (text: string) => {
    $("p-hint").textContent = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => ($("p-hint").textContent = ""), 2600);
  };
  /** Grade against the defaults, with the twist axis we've found so far. */
  const baseline = (): MotionProfile => ({ ...DEFAULT_PROFILE, axis });

  // ---- the try-out spin uses the real controller ----
  const controller = new SpinController(zone, {
    onWheel: (rate) => scene.setWheelRate(rate),
    onLaunch: (input) => void launch(input),
    onHint: (text) => hint(text),
    onHoldChange: (h) => {
      zone.classList.toggle("holding", h);
      if (h) {
        audio.unlock();
        scene.toHand();
      }
    },
    onMotionState: () => render(),
    onStep: (s) => {
      if (s === "flick") {
        audio.ready();
        voice.say("Now flick!", { key: "flick", everyMs: 1500, important: true });
      }
      render();
    },
    onMove: (move) => judge(move, { voice, audio, badge: $("p-grade") }),
  });

  // ---- holding the pad (hold, twist and flick steps) ----
  zone.addEventListener("pointerdown", (e) => {
    if (!started || step === "try" || holding) return;
    e.preventDefault();
    audio.unlock();
    holding = true;
    pointerId = e.pointerId;
    zone.setPointerCapture(e.pointerId);
    zone.classList.add("holding");
    demo.stopSounds();
    strokes.reset();
    spike = null;
    if (step === "hold") {
      holdTimer = setTimeout(() => {
        if (!holding || step !== "hold") return;
        audio.hop(0.4);
        goTo("twist");
      }, HOLD_MS);
    }
    render();
  });
  const release = (e: PointerEvent) => {
    if (!holding || e.pointerId !== pointerId) return;
    holding = false;
    pointerId = null;
    zone.classList.remove("holding");
    clearTimeout(holdTimer);
    if (step === "twist" || step === "flick") {
      hint("Keep your thumb on the pad");
      voice.say("Keep your thumb on the pad.", { key: "letgo", everyMs: 2500, important: true });
    }
    render();
  };
  zone.addEventListener("pointerup", release);
  zone.addEventListener("pointercancel", release);

  // ---- watching the moves ----
  window.addEventListener("devicemotion", (e) => {
    reader.screenAngle = screen.orientation?.angle ?? 0;
    const s = reader.read(e, performance.now());
    if (!s || !s.r || !holding) return;
    const acc = Math.hypot(s.ax, s.ay, s.az);
    if (step === "twist") watchTwist(s.t, s.r, acc);
    else if (step === "flick") watchFlick(s.t, s.r, acc);
  });

  function watchTwist(t: number, r: Vec3, acc: number) {
    if (Math.hypot(...r) >= AXIS_MIN) {
      rotations.push(r);
      if (rotations.length % 15 === 0) axis = principalAxis(rotations);
    }
    const rate = twistRate(r, baseline());
    // Spin the wheel the way the defaults would, so there's something to watch and hear.
    previewWheel = twistWheel(previewWheel, rate, baseline());
    scene.setWheelRate(previewWheel);
    const st = strokes.push(t, rate, acc);
    if (!st || st.peak < STROKE_MIN) return;
    // The first real stroke sets the way they spin; turning back the other way is winding up.
    if (!driveDir) driveDir = st.dir;
    if (st.dir !== driveDir) return;
    twistPeaks.push(st.peak);
    twistAcc.push(st.acc);
    const n = twistPeaks.length;
    paintCount(n, TWISTS);
    judge({ kind: "twist", grade: gradeTwist(st.peak, baseline()), peak: st.peak }, { voice, audio, badge: $("p-grade"), suffix: `${NUMBERS[n]}.` });
    if (n >= TWISTS) {
      axis = principalAxis(rotations);
      setTimeout(() => goTo("flick"), 900);
    }
  }

  function watchFlick(t: number, r: Vec3, acc: number) {
    previewWheel *= 0.999;
    const turn = Math.abs(twistRate(r, baseline()));
    if (!spike) {
      if (acc >= FLICK_MIN && t >= restUntil) spike = { start: t, peak: acc, twist: turn };
      return;
    }
    spike.peak = Math.max(spike.peak, acc);
    spike.twist = Math.max(spike.twist, turn);
    if (t - spike.start < FLICK_PEAK_MS) return;
    const { peak, twist } = spike;
    spike = null;
    restUntil = t + FLICK_REST_MS;
    flickPeaks.push(peak);
    flickTwist.push(twist);
    const n = flickPeaks.length;
    paintCount(n, FLICKS);
    audio.launch(Math.min(1, peak / 35));
    judge({ kind: "flick", grade: gradeFlick(peak, baseline()), peak }, { voice, audio, badge: $("p-grade"), suffix: `${NUMBERS[n]}.` });
    if (n >= FLICKS) setTimeout(finishCalibration, 1100);
  }

  function finishCalibration() {
    profile = buildProfile({ axis, twistPeaks, twistAcc, flickPeaks, flickTwist });
    saveProfile(profile);
    controller.profile = profile;
    const t = profile.typical!;
    const g = (v: number) => (v / 9.81).toFixed(1);
    const items = [
      `Your twist: about <b>${Math.round(t.twist)}°/s</b>. That's now a <b>good</b> twist, and it spins the wheel nicely.`,
      `Your flick: about <b>${g(t.flick)} g</b>. That's now a <b>good</b> flick. The ball launches from <b>${g(profile.flickPeak)} g</b> (it was ${g(DEFAULT_PROFILE.flickPeak)} g).`,
    ];
    if (profile.twistGuard > DEFAULT_PROFILE.twistGuard * 1.2) items.push("Your flick turns the phone as well, so I've made room for that.");
    if (Math.abs(axis[2]) < 0.85) items.push("You twist at an angle to the screen; that's fine, I'll follow your angle.");
    $("c-summary").innerHTML = items.map((i) => `<li>${i}</li>`).join("");
    holding = false;
    zone.classList.remove("holding");
    $("c-result").hidden = false;
    voice.say("Got it. Saved on this phone. Your normal twist and your normal flick now count as good.", { important: true });
  }

  function paintCount(n: number, of: number) {
    $("c-count").replaceChildren(
      ...Array.from({ length: of }, (_, i) => {
        const li = document.createElement("li");
        if (i < n) li.className = "got";
        return li;
      }),
    );
  }

  function paintSteps() {
    const i = ORDER.indexOf(step);
    for (const li of $("p-steps").querySelectorAll<HTMLElement>("li")) {
      const j = ORDER.indexOf(li.dataset.step as Step);
      li.className = j < i ? "done" : j === i ? "current" : "";
    }
  }

  function goTo(next: Step) {
    step = next;
    const c = COPY[next];
    $("p-title").textContent = c.title;
    $("p-body").textContent = c.body;
    paintSteps();
    demo.play(next === "try" ? "blind" : next, !holding);
    voice.say(c.say, { important: true });
    if (next === "twist") paintCount(0, TWISTS);
    else if (next === "flick") paintCount(0, FLICKS);
    else $("c-count").replaceChildren();
    if (next === "try") {
      holding = false;
      zone.classList.remove("holding");
      controller.setEnabled(true, scene.wheelRate);
    }
    render();
  }

  function render() {
    const title = zone.querySelector(".zone-title")!;
    const sub = zone.querySelector(".zone-sub")!;
    zone.classList.toggle("mine", started && !spinning);
    zone.classList.toggle("waiting", !started || spinning);
    zone.classList.toggle("flick", step === "try" && controller.currentStep === "flick" && !spinning);
    if (!started) [title.textContent, sub.textContent] = ["Press Start", ""];
    else if (spinning) [title.textContent, sub.textContent] = ["Watch the ball", ""];
    else if (step === "hold") [title.textContent, sub.textContent] = holding ? ["Keep holding…", ""] : ["HOLD HERE", "Thumb down, screen to the floor"];
    else if (!holding && step !== "try") [title.textContent, sub.textContent] = ["HOLD HERE", "Keep your thumb on the pad"];
    else if (step === "twist") [title.textContent, sub.textContent] = ["TWIST", "Your normal twist, with pauses"];
    else if (step === "flick") [title.textContent, sub.textContent] = ["FLICK", "Your normal throw, with pauses"];
    else if (controller.currentStep === "flick") [title.textContent, sub.textContent] = ["NOW FLICK!", "Throw right and snap your wrist"];
    else [title.textContent, sub.textContent] = ["HOLD & TWIST", "Twist until the chime"];
  }

  async function launch(input: SpinInput) {
    controller.setEnabled(false);
    spinning = true;
    audio.launch(input.ball);
    render();
    const plan: SpinPlan = {
      spinId: "calibrate",
      spinner: "you",
      pocket: Math.floor(Math.random() * POCKETS),
      wheel: input.wheel,
      ball: input.ball,
      seed: Math.floor(Math.random() * 2 ** 31),
    };
    await scene.play(plan, { onHop: (hop) => audio.hop(hop.strength), onRoll: (speed) => audio.roll(speed) });
    audio.roll(0);
    const color = pocketColor(plan.pocket);
    const c = $("p-callout");
    c.querySelector(".callout-main")!.textContent = String(plan.pocket);
    c.querySelector(".callout-sub")!.textContent = color === "green" ? "Zero" : color === "red" ? "Red" : "Black";
    c.className = `r-callout ${color}`;
    void c.offsetWidth;
    c.classList.add("show");
    spinning = false;
    voice.say(`${plan.pocket} ${color}.`, { important: true });
    if ($("p-done").dataset.shown !== "1") {
      $("p-done").dataset.shown = "1";
      $("p-done").hidden = false;
    }
    controller.setEnabled(true, scene.wheelRate);
    render();
  }

  function restart() {
    rotations.length = twistPeaks.length = twistAcc.length = flickPeaks.length = flickTwist.length = 0;
    axis = [0, 0, 1];
    driveDir = 0;
    previewWheel = 0;
    profile = null;
    controller.setEnabled(false);
    controller.profile = loadProfile();
    $("c-result").hidden = true;
    $("p-done").hidden = true;
    delete $("p-done").dataset.shown;
    goTo("twist");
  }

  // ---- buttons ----
  const paintVoice = () => {
    $("p-voice").textContent = voice.enabled ? "🗣️" : "🔇";
    $("p-voice").setAttribute("aria-label", voice.enabled ? "Turn spoken coaching off" : "Turn spoken coaching on");
  };
  $("p-voice").hidden = !voice.available;
  paintVoice();
  $("p-voice").addEventListener("click", () => {
    voice.setEnabled(!voice.enabled);
    paintVoice();
    voice.say("Coaching on.");
  });
  $("p-replay").addEventListener("click", () => {
    audio.unlock();
    demo.play(step === "try" ? "blind" : step, true);
    voice.say(COPY[step].say, { important: true });
  });
  $("c-current").hidden = !loadProfile().calibrated;
  if (controller.motionOff) {
    $("p-start-note").textContent = "Calibrating needs a phone's motion sensors. Open this page on the phone you spin with.";
    $("p-go").setAttribute("disabled", "");
  }
  $("p-go").addEventListener("click", () => {
    audio.unlock();
    if (audio.muted) audio.setMuted(false);
    if (controller.motion === "needs-permission") void controller.requestMotionPermission();
    void navigator.wakeLock?.request("screen").catch(() => {});
    $("p-start").hidden = true;
    started = true;
    goTo("hold");
  });
  $("c-try").addEventListener("click", () => {
    $("c-result").hidden = true;
    goTo("try");
  });
  $("c-redo").addEventListener("click", restart);
  $("c-again").addEventListener("click", () => {
    $("p-done").hidden = true;
    voice.say("Spin as much as you like.", { important: true });
  });
  $("c-reset").addEventListener("click", () => {
    clearProfile();
    controller.profile = DEFAULT_PROFILE;
    $("c-reset").textContent = "Forgotten: back to the default spin";
    voice.say("Forgotten. Back to the default spin.", { important: true });
  });

  backLinks();
  render();
  (window as { __rouletteLoaded?: () => void }).__rouletteLoaded?.(); // see public/boot-guard.js
  Object.assign(window, {
    calibrate: {
      controller,
      get step() { return step; },
      get profile() { return profile; },
      get counts() { return { twists: twistPeaks.length, flicks: flickPeaks.length }; },
    },
  });
}

boot();

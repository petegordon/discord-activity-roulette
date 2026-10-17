import "../remote/remote.css";
import "./practice.css";
import { WheelAudio } from "../audio";
import { pocketColor, POCKETS } from "../game/rules";
import { SpinController, type SpinStep } from "../input/controller";
import { WheelScene } from "../render/scene";
import { WHEEL_READY, type SpinInput, type SpinPlan } from "../wheel/spin";
import { twistTip, type CoachSample, type TwistTip } from "./coach";
import { Voice } from "./voice";

/**
 * Learn to spin: a practice wheel that walks you through hold → twist →
 * flick, then has you do it by ear, since in the game the phone is usually
 * twisted out of view. Nothing here talks to a room.
 */

type Lesson = "hold" | "twist" | "flick" | "blind";
const ORDER: Lesson[] = ["hold", "twist", "flick", "blind"];
/** Spins to land by ear before you're "ready". */
const BLIND_SPINS = 2;
/** How long the thumb must stay down to pass the first lesson. */
const HOLD_MS = 900;
/** Twisting this long without the wheel getting there earns a tip. */
const STUCK_MS = 2500;
const TIP_EVERY_MS = 3500;
/** One loop of a demo animation (practice.css). */
const DEMO_MS = 3200;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Copy = { title: string; body: string; say: string };

function lessonCopy(lesson: Lesson, motion: boolean, blindDone: number): Copy {
  switch (lesson) {
    case "hold":
      return {
        title: "1 · Hold the pad",
        body: motion
          ? "Hold your phone in one hand and press your thumb on the pad below. Keep it there for the whole spin. Letting go cancels."
          : "Press and hold the pad below. Keep holding for the whole spin.",
        say: "Press your thumb on the pad, and keep it there.",
      };
    case "twist":
      return motion
        ? {
            title: "2 · Twist to spin the wheel",
            body: "Turn the phone like a dial or a doorknob, keeping the screen facing the same way. Quick twists, again and again: each one speeds the wheel up, and the ticks get faster. When it's fast enough you'll hear the chime.",
            say: "Now twist your phone like a dial. Quick turns, again and again. Listen for the chime.",
          }
        : {
            title: "2 · Drag to spin the wheel",
            body: "Keep holding and drag sideways, again and again, to push the wheel round. When it's fast enough you'll hear the chime.",
            say: "Keep holding, and drag sideways to spin the wheel. Listen for the chime.",
          };
    case "flick":
      return motion
        ? {
            title: "3 · Flick to throw the ball",
            body: "Chime? Stop twisting and snap your wrist, like flicking water off your hand. Any direction works. A harder flick runs the ball for longer.",
            say: "Now flick!",
          }
        : {
            title: "3 · Flick to throw the ball",
            body: "Chime? Swipe quickly upward and let go to throw the ball.",
            say: "Now flick upward and let go.",
          };
    case "blind":
      return {
        title: "4 · Now by ear",
        body: `At the table you can't watch this screen while you twist. Don't look: thumb down, twist until the chime, then flick. Spins by ear: ${blindDone} of ${BLIND_SPINS}.`,
        say:
          blindDone === 0
            ? "Now do it without looking. Thumb down, twist until you hear the chime, then flick."
            : `That's ${blindDone}. Once more, by ear.`,
      };
  }
}

const TIPS: Record<TwistTip, string> = {
  axis: "Keep the screen facing the same way, and turn it like a dial.",
  shake: "Don't shake it. Turn it, like a doorknob.",
  faster: "Twist faster, in quick turns.",
};

function flickWords(strength: number) {
  if (strength >= 0.8) return "Big flick!";
  if (strength >= 0.45) return "Nice flick!";
  return "Gentle flick. Snap harder to run the ball longer.";
}

function boot() {
  const audio = new WheelAudio();
  const voice = new Voice();
  const scene = new WheelScene($("stage"));
  const zone = $("zone");

  let lesson: Lesson = "hold";
  let blindDone = 0;
  /** Passed every lesson; now just spinning for fun. */
  let finished = false;
  let started = false;
  let spinning = false;
  let holding = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let stuckSince = 0;
  let wheel = 0;
  let lastLaunch: SpinInput | null = null;
  const coach: CoachSample[] = [];
  let hintTimer: ReturnType<typeof setTimeout> | undefined;

  const motion = () => controller.motion === "active";

  const hint = (text: string) => {
    $("p-hint").textContent = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => ($("p-hint").textContent = ""), 2600);
  };

  // ---- the demo animation, with the sounds that go with it ----
  const demo = $("p-demo");
  let demoTimers: ReturnType<typeof setTimeout>[] = [];
  function playDemo(which: Lesson, sound: boolean) {
    demoTimers.forEach(clearTimeout);
    demoTimers = [];
    demo.className = "demo";
    void demo.offsetWidth; // restart the CSS animation
    demo.classList.add(`demo-${which}`);
    if (!sound) return;
    const at = (ms: number, fn: () => void) => demoTimers.push(setTimeout(fn, ms));
    if (which === "twist" || which === "blind") {
      // The ticks speed up with each of the three twists, then the chime.
      const end = which === "twist" ? 0.92 : 0.6;
      for (let ms = 0; ms < DEMO_MS * end; ms += 40) at(ms, () => !holding && audio.wheel(0.4 + (ms / (DEMO_MS * end)) * 2.2));
      at(DEMO_MS * end, () => !holding && audio.ready());
    }
    if (which === "flick") at(DEMO_MS * 0.44, () => !holding && audio.launch(0.8));
    if (which === "blind") at(DEMO_MS * 0.8, () => !holding && audio.launch(0.8));
  }
  $("p-replay").addEventListener("click", () => {
    audio.unlock();
    playDemo(lesson, true);
    voice.say(lessonCopy(lesson, motion(), blindDone).say);
  });

  function paintSteps() {
    const i = ORDER.indexOf(lesson);
    for (const li of $("p-steps").querySelectorAll<HTMLElement>("li")) {
      const j = ORDER.indexOf(li.dataset.lesson as Lesson);
      li.className = j < i ? "done" : j === i ? "current" : "";
    }
  }

  function goTo(next: Lesson, opts: { speak?: boolean; demo?: boolean } = {}) {
    lesson = next;
    const copy = lessonCopy(next, motion(), blindDone);
    $("p-title").textContent = copy.title;
    $("p-body").textContent = copy.body;
    paintSteps();
    // Mid-hold (twist → flick), the player isn't looking: just say it, no demo sounds over their own.
    playDemo(next, opts.demo ?? !holding);
    if (opts.speak ?? true) voice.say(copy.say);
    render();
  }

  function render() {
    const title = zone.querySelector(".zone-title")!;
    const sub = zone.querySelector(".zone-sub")!;
    const step: SpinStep = controller.currentStep;
    const ready = !spinning && started;
    zone.classList.toggle("mine", ready);
    zone.classList.toggle("waiting", !ready);
    zone.classList.toggle("flick", ready && step === "flick");
    zone.classList.toggle("p-blind", lesson === "blind");
    if (!started) {
      title.textContent = "Press Start";
      sub.textContent = "";
    } else if (spinning) {
      title.textContent = "Watch the ball";
      sub.textContent = lastLaunch ? `Flick strength ${Math.round(lastLaunch.ball * 100)}%` : "";
    } else if (lesson === "hold" && !holding) {
      title.textContent = "HOLD HERE";
      sub.textContent = "Thumb down and keep it there";
    } else if (lesson === "hold") {
      title.textContent = "Keep holding…";
      sub.textContent = "";
    } else if (step === "flick") {
      title.textContent = "NOW FLICK!";
      sub.textContent = motion() ? "Snap your wrist to launch the ball" : "Swipe up and let go";
    } else {
      title.textContent = "HOLD & TWIST";
      sub.textContent = motion() ? "Twist your phone like a dial" : "Hold and drag sideways";
    }
    const fill = Math.min(1, Math.abs(wheel) / (WHEEL_READY * 2));
    $("p-meter-fill").style.width = `${fill * 100}%`;
    zone.classList.toggle("p-ready", Math.abs(wheel) >= WHEEL_READY);
  }

  const controller = new SpinController(zone, {
    onWheel: (rate) => {
      wheel = rate;
      scene.setWheelRate(rate);
      render();
    },
    onLaunch: (input) => void launch(input),
    onHint: (text) => {
      hint(text);
      // Say the hint the way the lesson puts it.
      if (/first/i.test(text)) voice.say("Twist first. Wait for the chime, then flick.", { key: "early", everyMs: 3000 });
      else if (/flick/i.test(text) && motion()) voice.say("You let go. Keep your thumb down, then flick.", { key: "letgo", everyMs: 3000 });
      else if (/flick/i.test(text)) voice.say("Swipe up quickly as you let go.", { key: "letgo", everyMs: 3000 });
      else if (lesson !== "hold") voice.say("Keep your thumb on the pad while you twist.", { key: "letgo", everyMs: 3000 });
    },
    onHoldChange: (h) => {
      holding = h;
      zone.classList.toggle("holding", h);
      if (h) {
        audio.unlock();
        scene.toHand();
        stuckSince = performance.now();
        demoTimers.forEach(clearTimeout);
      }
      clearTimeout(holdTimer);
      if (h && lesson === "hold") {
        holdTimer = setTimeout(() => {
          if (holding && lesson === "hold") {
            audio.hop(0.4);
            goTo("twist", { demo: false });
          }
        }, HOLD_MS);
      }
      render();
    },
    onMotionState: () => started && goTo(lesson, { speak: false, demo: false }),
    onStep: (step) => {
      if (step === "flick") {
        audio.ready();
        if ("vibrate" in navigator) navigator.vibrate([30, 40, 30]);
        if (lesson === "twist") goTo("flick");
        else if (lesson === "flick") voice.say("Now flick!", { key: "flick", everyMs: 1500 });
        // By ear, the chime is the only cue, as in the game.
      }
      render();
    },
  });

  // ---- coaching: why isn't the wheel speeding up? ----
  window.addEventListener("devicemotion", (e) => {
    if (!holding || spinning) return;
    const r = e.rotationRate;
    const a = e.acceleration;
    const now = performance.now();
    coach.push({
      t: now,
      alpha: r?.alpha ?? 0,
      tilt: Math.max(Math.abs(r?.beta ?? 0), Math.abs(r?.gamma ?? 0)),
      acc: a && a.x !== null ? Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0) : 0,
    });
    while (coach.length && now - coach[0].t > 2000) coach.shift();
    if (lesson === "hold" || controller.currentStep === "flick") {
      stuckSince = now;
      return;
    }
    if (now - stuckSince < STUCK_MS) return;
    const tip = twistTip(coach, now);
    if (!tip) return;
    hint(TIPS[tip]);
    voice.say(TIPS[tip], { key: "tip", everyMs: TIP_EVERY_MS });
  });

  async function launch(input: SpinInput) {
    controller.setEnabled(false);
    spinning = true;
    lastLaunch = input;
    audio.launch(input.ball);
    const strength = flickWords(input.ball);
    if (lesson !== "blind" || finished) voice.say(strength);
    render();
    const plan: SpinPlan = {
      spinId: "practice",
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
    wheel = scene.wheelRate;

    if (finished) {
      voice.say(`${plan.pocket} ${color}.`);
    } else if (lesson !== "blind") {
      voice.say(`${plan.pocket} ${color}. That's a spin!`);
      setTimeout(() => goTo("blind"), 1800);
    } else if (lesson === "blind") {
      blindDone++;
      if (blindDone >= BLIND_SPINS) {
        finished = true;
        voice.say(`${plan.pocket} ${color}. You're ready!`);
        $("p-done").hidden = false;
      } else {
        voice.say(`${plan.pocket} ${color}.`);
        setTimeout(() => goTo("blind"), 1400);
      }
    }
    controller.setEnabled(true, scene.wheelRate);
    render();
  }

  // ---- start, voice toggle, keep going ----
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

  if (controller.motionOff) $("p-start-note").textContent = "No motion sensors here, so you'll drag instead. Open this page on your phone to learn the real thing.";
  $("p-go").addEventListener("click", () => {
    // iOS only grants motion, sound and speech from inside a tap.
    audio.unlock();
    if (audio.muted) audio.setMuted(false);
    if (controller.motion === "needs-permission") void controller.requestMotionPermission();
    void navigator.wakeLock?.request("screen").catch(() => {});
    $("p-start").hidden = true;
    started = true;
    controller.setEnabled(true, 0);
    goTo("hold");
  });
  $("p-again").addEventListener("click", () => {
    $("p-done").hidden = true;
    voice.say("Spin as much as you like.");
  });

  // Back to wherever we came from, keeping that page's room (and a remote's key).
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href="/"]')) {
    a.addEventListener("click", (e) => {
      if (document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) {
        e.preventDefault();
        history.back();
      }
    });
  }

  render();
  (window as { __rouletteLoaded?: () => void }).__rouletteLoaded?.(); // see public/boot-guard.js
  Object.assign(window, { practice: { controller, get lesson() { return lesson; }, get blindDone() { return blindDone; } } });
}

boot();

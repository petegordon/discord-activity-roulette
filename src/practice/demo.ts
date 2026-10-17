import type { WheelAudio } from "../audio";

/** The moves the demo can show. "blind" is the whole spin, by ear. */
export type DemoMove = "hold" | "twist" | "flick" | "blind";

/** One loop of a demo animation (demo.css). */
export const DEMO_MS = 3200;

const MARKUP = `
  <div class="demo-floor">
    <div class="demo-wheel"></div>
    <div class="demo-ball"></div>
    <div class="demo-streaks"><i></i><i></i><i></i></div>
    <div class="demo-rig">
      <div class="demo-arm"></div>
      <div class="demo-flipper">
        <div class="demo-face demo-front"><div class="demo-pad"></div><div class="demo-thumb"></div></div>
        <div class="demo-face demo-back"><div class="demo-camera"></div><i></i><i></i><i></i><i></i></div>
      </div>
    </div>
  </div>
  <div class="demo-chime">🔔</div>
  <div class="demo-snap">SNAP →</div>
  <div class="demo-label"></div>
`;

const LABELS: Record<DemoMove, string> = {
  hold: "thumb on, then screen down",
  twist: "screen down · turn like the wheel",
  flick: "throw right · snap the wrist",
  blind: "👂 by ear",
};

/**
 * A looping picture of the move, drawn the way it's played: phone held
 * screen-down over the wheel, thumb on the pad underneath. Twisting turns
 * it like the wheel's own handle; the flick throws the arm to the right
 * and snaps the wrist. Plays the matching sounds the first time round.
 */
export class Demo {
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly el: HTMLElement,
    private readonly audio: WheelAudio,
    /** Sounds stay quiet while this is true (the player is holding the pad, making their own). */
    private readonly busy: () => boolean = () => false,
  ) {
    el.classList.add("demo");
    el.innerHTML = MARKUP;
  }

  play(move: DemoMove, sound: boolean) {
    this.stopSounds();
    this.el.className = "demo";
    void this.el.offsetWidth; // restart the CSS animation
    this.el.classList.add(`demo-${move}`);
    this.el.querySelector(".demo-label")!.textContent = LABELS[move];
    if (!sound) return;
    const at = (ms: number, fn: () => void) => this.timers.push(setTimeout(() => !this.busy() && fn(), ms));
    if (move === "twist" || move === "blind") {
      // The ticks speed up with each twist, then the chime.
      const end = move === "twist" ? 0.9 : 0.58;
      for (let ms = 0; ms < DEMO_MS * end; ms += 40) at(ms, () => this.audio.wheel(0.4 + (ms / (DEMO_MS * end)) * 2.2));
      at(DEMO_MS * end, () => this.audio.ready());
    }
    if (move === "flick") at(DEMO_MS * 0.46, () => this.audio.launch(0.8));
    if (move === "blind") at(DEMO_MS * 0.8, () => this.audio.launch(0.8));
  }

  stopSounds() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
}

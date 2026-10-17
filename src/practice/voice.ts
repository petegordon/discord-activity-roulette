const VOICE_KEY = "roulette.voice";

/**
 * Spoken coaching for the practice page, since the spinner can't watch the
 * screen while twisting. Uses the browser's speech synthesis; on iOS the
 * first line must be spoken from inside a tap (the page's Start button).
 */
export class Voice {
  enabled: boolean;
  private readonly synth = typeof speechSynthesis === "undefined" ? null : speechSynthesis;
  private lastSaid = new Map<string, number>();
  /** An important line (`important`) isn't cut off by ordinary ones until then. */
  private quietUntil = 0;

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(VOICE_KEY);
    } catch {
      // storage unavailable
    }
    this.enabled = stored !== "0";
  }

  get available() {
    return !!this.synth;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.synth?.cancel();
    try {
      localStorage.setItem(VOICE_KEY, on ? "1" : "0");
    } catch {
      // storage unavailable
    }
  }

  /**
   * Say `text`, cutting off whatever is being said. With `key` and `everyMs`,
   * the same kind of line isn't repeated more often than that.
   */
  say(text: string, opts: { key?: string; everyMs?: number; important?: boolean } = {}) {
    if (!this.enabled || !this.synth) return;
    const now = performance.now();
    if (!opts.important && now < this.quietUntil) return;
    if (opts.important) this.quietUntil = now + 1100;
    if (opts.key) {
      if (now - (this.lastSaid.get(opts.key) ?? -Infinity) < (opts.everyMs ?? 0)) return;
      this.lastSaid.set(opts.key, now);
    }
    this.synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 1.08;
    this.synth.speak(u);
  }
}

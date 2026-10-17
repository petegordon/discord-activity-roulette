const MUTE_KEY = "roulette.muted";

/**
 * Synthesised roulette sounds (no audio files): the ball's roll around the
 * track, clacks as it hops over the frets, and soft ticks from the wheel.
 */
export class WheelAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private rollGain: GainNode | null = null;
  private rollFilter: BiquadFilterNode | null = null;
  private lastTick = 0;
  muted: boolean;

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(MUTE_KEY);
    } catch {
      // storage unavailable
    }
    this.muted = stored === "1";
  }

  /** Call from a user gesture; browsers keep audio suspended until then. */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      const len = Math.floor(this.ctx.sampleRate * 1);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      // The roll: looping noise through a low-pass whose level follows the ball's speed.
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      this.rollFilter = this.ctx.createBiquadFilter();
      this.rollFilter.type = "lowpass";
      this.rollFilter.frequency.value = 600;
      this.rollGain = this.ctx.createGain();
      this.rollGain.gain.value = 0;
      src.connect(this.rollFilter).connect(this.rollGain).connect(this.ctx.destination);
      src.start();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) this.roll(0);
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      // storage unavailable
    }
  }

  /** The ball rolling at `speed` rad/s (0 = silent). Call every frame while it rolls. */
  roll(speed: number) {
    if (!this.ctx || !this.rollGain || !this.rollFilter) return;
    const level = this.muted ? 0 : Math.min(0.22, speed / 60);
    const t = this.ctx.currentTime;
    this.rollGain.gain.setTargetAtTime(level, t, 0.05);
    this.rollFilter.frequency.setTargetAtTime(300 + speed * 45, t, 0.05);
  }

  /** The wheel turning at `rate` rad/s: a tick each time a fret passes a fixed point, thinned out. */
  wheel(rate: number) {
    const now = performance.now();
    const perSec = (Math.abs(rate) * 37) / (Math.PI * 2);
    if (perSec < 0.5) return;
    const gap = Math.max(70, 1000 / perSec);
    if (now - this.lastTick < gap) return;
    this.lastTick = now;
    this.click(4200 + Math.random() * 600, 0.025, 0.02);
  }

  /** The ball hitting a fret or pocket. */
  hop(strength: number) {
    this.click(2400 + Math.random() * 900, 0.08 + strength * 0.3, 0.05);
  }

  /**
   * Two rising notes: the wheel is going fast enough, flick now. It's the cue
   * to listen for, since the spinner usually can't see the screen (and iPhones
   * can't vibrate from a web page).
   */
  ready() {
    this.tone(880, 0, 0.14);
    this.tone(1318.5, 0.12, 0.3);
  }

  /**
   * How a twist or flick felt, as a quick blip: one low note for too soft,
   * rising to three bright ones for strong. Distinct from the flick chime.
   */
  grade(g: "too-soft" | "soft" | "good" | "strong") {
    const notes = { "too-soft": [220], soft: [392], good: [523, 659], strong: [659, 784, 1047] }[g];
    notes.forEach((f, i) => this.tone(f, i * 0.06, 0.09, "triangle"));
  }

  /** The ball leaving your hand: a whoosh, brighter for a harder flick. */
  launch(strength: number) {
    if (this.muted || !this.ctx || !this.noise || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 1.5;
    filter.frequency.setValueAtTime(500, t);
    filter.frequency.exponentialRampToValueAtTime(1500 + strength * 2500, t + 0.22);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.25 + strength * 0.25, t + 0.04);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    src.connect(filter).connect(env).connect(ctx.destination);
    src.start(t, 0, 0.35);
  }

  private tone(freq: number, delay: number, dur: number, type: OscillatorType = "sine") {
    if (this.muted || !this.ctx || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.22, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private click(freq: number, gain: number, dur: number) {
    if (this.muted || !this.ctx || !this.noise || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    filter.Q.value = 3;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(env).connect(ctx.destination);
    src.start(t, Math.random() * 0.8, dur + 0.02);
  }
}

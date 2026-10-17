import type { WheelAudio } from "../audio";
import type { Move } from "../input/controller";
import type { Grade } from "../input/profile";
import type { Voice } from "./voice";

const TWIST_WORDS: Record<Grade, string> = { "too-soft": "Too soft", soft: "Soft", good: "Good", strong: "Strong" };
const FLICK_WORDS: Record<Grade, string> = { "too-soft": "Too soft. Snap harder.", soft: "Soft flick.", good: "Good flick!", strong: "Strong flick!" };
const BADGE: Record<Grade, string> = { "too-soft": "TOO SOFT", soft: "SOFT", good: "GOOD", strong: "STRONG" };

/**
 * Tells the player how a move felt three ways at once: a tone (instant),
 * a spoken word, and a badge that flashes on `badge` for anyone looking.
 */
export function judge(move: Move, out: { voice: Voice; audio: WheelAudio; badge?: HTMLElement; suffix?: string }) {
  out.audio.grade(move.grade);
  const words = (move.kind === "flick" ? FLICK_WORDS : TWIST_WORDS)[move.grade];
  out.voice.say(out.suffix ? `${words} ${out.suffix}` : words);
  const b = out.badge;
  if (!b) return;
  b.textContent = `${move.kind === "flick" ? "FLICK" : "TWIST"} · ${BADGE[move.grade]}`;
  b.className = `p-grade ${move.grade}`;
  void b.offsetWidth; // restart the animation
  b.classList.add("show");
}

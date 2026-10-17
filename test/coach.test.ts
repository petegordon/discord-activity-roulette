import { describe, expect, it } from "vitest";
import { twistTip, type CoachSample } from "../src/practice/coach";

/** 1.2 s of samples at 60 Hz, shaped by `f`. */
function samples(f: (i: number) => Partial<CoachSample>): CoachSample[] {
  return Array.from({ length: 72 }, (_, i) => ({ t: i * 16, alpha: 0, tilt: 0, acc: 0, ...f(i) }));
}
const now = 72 * 16;

describe("twistTip", () => {
  it("is quiet when the twist is a good one", () => {
    expect(twistTip(samples((i) => ({ alpha: i % 20 < 10 ? 320 : -150 })), now)).toBeNull();
  });

  it("spots tipping the phone instead of dialling it", () => {
    expect(twistTip(samples((i) => ({ alpha: 40, tilt: i % 20 < 10 ? 300 : -250 })), now)).toBe("axis");
  });

  it("spots shaking without turning", () => {
    expect(twistTip(samples((i) => ({ alpha: 30, acc: i % 10 < 5 ? 18 : 2 })), now)).toBe("shake");
  });

  it("asks for faster twists when they're too gentle", () => {
    expect(twistTip(samples(() => ({ alpha: 90 })), now)).toBe("faster");
  });

  it("needs enough recent samples to judge", () => {
    expect(twistTip(samples(() => ({ alpha: 90 })).slice(0, 5), now)).toBeNull();
    expect(twistTip(samples(() => ({ alpha: 90 })), now + 5000)).toBeNull();
  });
});

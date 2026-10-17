// End-to-end test for Calibrate (/calibrate), with synthetic DeviceMotion from a phone held screen-down.
// Usage: node scripts/e2e-calibrate.mjs [baseUrl]
// A gentle player (160°/s twists, 1.1 g flicks, which wouldn't launch with the defaults) calibrates,
// then a try-out spin with those same moves must launch and be judged "good".
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const outDir = "scripts/out";
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const errors = [];
const fail = (msg) => {
  throw new Error(msg);
};

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    if (typeof DeviceMotionEvent === "undefined") {
      window.DeviceMotionEvent = class extends Event {
        constructor(type, init = {}) {
          super(type);
          Object.assign(this, { acceleration: null, accelerationIncludingGravity: null, rotationRate: null, interval: 16 }, init);
        }
      };
    }
    window.__motion = { x: 0, y: 0, z: 0, rot: 0 };
    setInterval(() => {
      const m = window.__motion;
      const n = () => (Math.random() - 0.5) * 6;
      window.dispatchEvent(
        new DeviceMotionEvent("devicemotion", {
          acceleration: { x: m.x, y: m.y, z: m.z },
          // Screen down: gravity reads out of the back.
          accelerationIncludingGravity: { x: m.x, y: m.y, z: m.z - 9.8 },
          rotationRate: { alpha: m.rot + n(), beta: n(), gamma: n() },
          interval: 16,
        }),
      );
    }, 16);
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  await page.goto(`${base}/calibrate`);
  await page.click("#p-go");
  const step = () => page.evaluate(() => window.calibrate.step);
  const sleep = (ms) => page.waitForTimeout(ms);
  const box = await page.locator("#zone").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(1100);
  if ((await step()) !== "twist") fail(`hold didn't pass: ${await step()}`);

  // A gentle twister: six 160°/s twists, winding back slowly between.
  const twists = (n, peak) =>
    page.evaluate(
      async ([n, peak]) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < n; i++) {
          for (let k = 0; k < 12; k++) {
            window.__motion = { x: 0, y: 0, z: 0, rot: peak * Math.sin((k / 12) * Math.PI) };
            await sleep(16);
          }
          window.__motion = { x: 0, y: 0, z: 0, rot: -70 };
          await sleep(180);
          window.__motion = { x: 0, y: 0, z: 0, rot: 0 };
          await sleep(120);
        }
      },
      [n, peak],
    );
  await twists(6, 160);
  await page.waitForFunction(() => window.calibrate.step === "flick", null, { timeout: 5000 });
  console.log("twists recorded:", (await page.evaluate(() => window.calibrate.counts)).twists);
  await page.screenshot({ path: `${outDir}/calibrate-flick.png` });

  // Five soft flicks (11 m/s², under the default 13) thrown to the right.
  const flicks = (n, peak) =>
    page.evaluate(
      async ([n, peak]) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < n; i++) {
          window.__motion = { x: peak, y: 0, z: 0, rot: 120 };
          await sleep(60);
          window.__motion = { x: 0, y: 0, z: 0, rot: 0 };
          await sleep(900);
        }
      },
      [n, peak],
    );
  await flicks(5, 11);
  await page.waitForSelector("#c-result:not([hidden])", { timeout: 5000 });
  const profile = await page.evaluate(() => JSON.parse(localStorage.getItem("roulette.motionProfile")));
  console.log("saved profile:", JSON.stringify({ flickPeak: profile.flickPeak.toFixed(1), gain: profile.twistGain.toFixed(2), typical: profile.typical }));
  if (!(profile.flickPeak < 11)) fail("an 11 m/s² flick wouldn't launch with the calibration");
  await page.screenshot({ path: `${outDir}/calibrate-result.png` });
  await page.mouse.up();

  // Try a spin with the same gentle moves.
  await page.click("#c-try");
  await page.waitForSelector("#zone.mine", { timeout: 5000 });
  await page.mouse.down();
  await twists(5, 160);
  const title = await page.textContent("#zone .zone-title");
  if (title !== "NOW FLICK!") fail(`try-out twist didn't reach the flick: "${title}"`);
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__motion = { x: 11, y: 0, z: 0, rot: 0 };
    await sleep(60);
    window.__motion = { x: 0, y: 0, z: 0, rot: 0 };
    await sleep(250);
  });
  const grade = await page.textContent("#p-grade");
  await page.mouse.up();
  await page.waitForSelector("#zone .zone-title:text('Watch the ball')", { timeout: 3000 });
  console.log("try-out flick judged:", grade);
  if (!/GOOD/.test(grade)) fail(`expected a good flick, got "${grade}"`);
  await page.waitForSelector("#p-done:not([hidden])", { timeout: 15_000 });
  await page.screenshot({ path: `${outDir}/calibrate-done.png` });

  // The practice page picks the calibration up.
  await page.goto(`${base}/practice`);
  if (await page.$("#p-calibrated[hidden]")) fail("practice page didn't see the calibration");
  if (errors.length) fail(`page errors:\n${errors.join("\n")}`);
  console.log("CALIBRATE E2E PASSED");
} finally {
  await browser.close();
}

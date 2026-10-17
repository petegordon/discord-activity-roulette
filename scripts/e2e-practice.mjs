// End-to-end test for Learn to spin (/practice), with synthetic DeviceMotion.
// Usage: node scripts/e2e-practice.mjs [baseUrl]
// Walks hold → twist → flick → two spins by ear, and saves a screenshot of each lesson.
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
    window.__motion = { x: 0, y: 0, z: 0, rot: 0, tilt: 0 };
    setInterval(() => {
      const m = window.__motion;
      window.dispatchEvent(
        new DeviceMotionEvent("devicemotion", {
          acceleration: { x: m.x, y: m.y, z: m.z },
          accelerationIncludingGravity: { x: m.x, y: m.y + 9.8, z: m.z },
          rotationRate: { alpha: m.rot, beta: m.tilt, gamma: 0 },
          interval: 16,
        }),
      );
    }, 16);
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  await page.goto(`${base}/practice`);
  await page.screenshot({ path: `${outDir}/practice-0-start.png` });
  await page.click("#p-go");
  const lesson = () => page.evaluate(() => window.practice.lesson);
  await page.waitForTimeout(400);
  if ((await lesson()) !== "hold") fail(`expected hold, got ${await lesson()}`);
  await page.screenshot({ path: `${outDir}/practice-1-hold.png` });

  const box = await page.locator("#zone").boundingBox();
  const sleep = (ms) => page.waitForTimeout(ms);
  const set = (m) => page.evaluate((m) => (window.__motion = { x: 0, y: 0, z: 0, rot: 0, tilt: 0, ...m }), m);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(1100);
  if ((await lesson()) !== "twist") fail(`holding didn't pass the first lesson: ${await lesson()}`);
  await page.screenshot({ path: `${outDir}/practice-2-twist.png` });

  // Tipping the phone (wrong axis) for a while earns the "turn it flat" tip.
  await set({ tilt: 300 });
  await sleep(3200);
  const tip = await page.textContent("#p-hint");
  if (!/flat/.test(tip)) fail(`no axis tip: "${tip}"`);
  console.log("wrong-axis tip:", tip);

  async function twist() {
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 40; i++) {
        window.__motion = { x: 0, y: 0, z: 0, rot: i % 10 < 7 ? 450 : -200, tilt: 0 };
        await sleep(20);
      }
      window.__motion = { x: 0, y: 0, z: 0, rot: 0, tilt: 0 };
      await sleep(200);
    });
  }
  async function flick() {
    await set({ z: -32 });
    await sleep(64);
    await set({});
    await sleep(300);
  }
  await twist();
  if ((await lesson()) !== "flick") fail(`twisting didn't reach the flick lesson: ${await lesson()}`);
  await page.screenshot({ path: `${outDir}/practice-3-flick.png` });
  await flick();
  await page.mouse.up();
  await page.waitForSelector("#zone .zone-title:text('Watch the ball')", { timeout: 3000 });
  await sleep(1500);
  await page.screenshot({ path: `${outDir}/practice-3b-rolling.png` });
  await page.waitForFunction(() => window.practice.lesson === "blind", null, { timeout: 15_000 });
  await page.screenshot({ path: `${outDir}/practice-4-blind.png` });

  for (let n = 1; n <= 2; n++) {
    await page.waitForSelector("#zone.mine", { timeout: 15_000 });
    await page.mouse.down();
    await twist();
    await flick();
    await page.mouse.up();
    await page.waitForFunction((n) => window.practice.blindDone >= n, n, { timeout: 15_000 });
    console.log("spin by ear", n, "done");
  }
  await page.waitForSelector("#p-done:not([hidden])", { timeout: 5000 });
  await page.screenshot({ path: `${outDir}/practice-5-done.png` });
  if (errors.length) fail(`page errors:\n${errors.join("\n")}`);
  console.log("PRACTICE E2E PASSED");
} finally {
  await browser.close();
}

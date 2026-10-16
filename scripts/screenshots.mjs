// Captures the README screenshots: a phone and a desktop table mid-game, with bets down.
// Usage: node scripts/screenshots.mjs [baseUrl]   (expects `npm run preview` serving baseUrl)
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const outDir = "public/screenshots";
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

async function shoot(name, viewport, query) {
  const room = `SHOT${Date.now().toString(36).toUpperCase()}`;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => localStorage.setItem("roulette.name", "Pete"));
  const p = await ctx.newPage();
  await p.goto(`${base}/?room=${room}&t=relay&debug${query}`);
  await p.waitForFunction(() => window.roulette?.room?.players?.length > 0);
  await p.click("#start");
  // One spin so the history strip and winning pocket show, then some bets for the next.
  await p.click("#quick-spin");
  await p.waitForFunction(() => window.roulette.room.game.spun === 1 && !window.roulette.scene.isSpinning, null, { timeout: 25_000 });
  await p.waitForTimeout(2200);
  for (const [chip, spot] of [["v25", "red"], ["v5", "n17"], ["v100", "d2"], ["v5", "n32"]]) {
    await p.click(`.chip-pick.${chip}`);
    await p.click(`.spot[data-spot="${spot}"]`);
  }
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${outDir}/${name}.png` });
  await ctx.close();
}

await shoot("phone", { width: 390, height: 780 }, "");
await shoot("desktop", { width: 1280, height: 720 }, "&nomotion");
await browser.close();
console.log("saved to", outDir);

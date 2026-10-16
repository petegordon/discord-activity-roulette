// End-to-end smoke test: two (or more) headless Chrome players in one room.
// Usage: node scripts/e2e.mjs [baseUrl] [relay|peerjs] [players]
// Expects `npm run preview` (wrangler dev) to be serving baseUrl.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const transport = process.argv[3] ?? "relay";
const count = Number(process.argv[4] ?? 2);
const room = `E2E${Date.now().toString(36).toUpperCase()}`;
const names = ["Alice", "Bob", "Cara", "Dan"];
const outDir = "scripts/out";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
});

const errors = [];
const players = [];
for (let i = 0; i < count; i++) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 1, hasTouch: true });
  await ctx.addInitScript((name) => localStorage.setItem("roulette.name", name), names[i]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${names[i]}] ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/is taken|Aborting|Could not connect to peer/.test(m.text()) && errors.push(`[${names[i]}] console: ${m.text()}`));
  await page.goto(`${base}/?room=${room}&t=${transport}&debug`);
  await page.waitForFunction(() => window.roulette?.room?.players?.length > 0, null, { timeout: 30_000, polling: 200 });
  players.push({ name: names[i], page });
  await page.waitForTimeout(300);
}

process.on("unhandledRejection", async (e) => {
  console.log("FAILED:", e.message.split("\n")[0], "at line", (e.stack.match(/e2e\.mjs:(\d+)/) ?? [])[1]);
  for (const p of players) {
    try {
      console.log(p.name, JSON.stringify(await p.page.evaluate(() => ({
        isHost: window.roulette.room.isHost, hostId: window.roulette.room.hostId, self: window.roulette.self.id,
        players: window.roulette.room.players.map((x) => x.id), phase: window.roulette.room.game.phase, spinner: window.roulette.room.game.spinnerId,
        spun: window.roulette.room.game.spun, spinning: window.roulette.scene.isSpinning,
        zone: document.querySelector(".zone-title")?.textContent, hint: document.getElementById("hint").textContent,
        status: document.getElementById("status").textContent,
      }))));
    } catch (err) { console.log(p.name, "eval failed", err.message); }
  }
  console.log("errors:", errors);
  process.exit(2);
});

const snapshot = (p) => p.page.evaluate(() => ({ players: window.roulette.room.players.map((x) => x.name), game: window.roulette.room.game, isHost: window.roulette.room.isHost, self: window.roulette.self.id }));
const selfIds = await Promise.all(players.map((p) => p.page.evaluate(() => window.roulette.self.id)));

// Everyone sees everyone.
await Promise.all(players.map((p) => p.page.waitForFunction((n) => window.roulette.room.players.length === n, count, { timeout: 30_000, polling: 200 })));
console.log("joined:", (await snapshot(players[0])).players.join(", "));
const host = (await Promise.all(players.map(snapshot))).findIndex((s) => s.isHost);
console.log("host:", players[host].name);
await players[0].page.screenshot({ path: `${outDir}/${transport}-lobby.png` });

// Host starts a short match.
await players[host].page.selectOption("#rounds", "5");
await players[host].page.click("#start");
await players[0].page.waitForTimeout(500);

/** Tap a spot on the betting table. */
const bet = (p, spot) => p.page.click(`.spot[data-spot="${spot}"]`);

let spins = 0;
for (; spins < 10; spins++) {
  const s = await snapshot(players[0]);
  if (s.game.phase === "matchOver") break;
  // Everyone bets: a 25 chip on red, and a 5 chip on a number.
  for (const [i, p] of players.entries()) {
    await p.page.click(".chip-pick.v25");
    await bet(p, i % 2 ? "black" : "red");
    await p.page.click(".chip-pick.v5");
    await bet(p, `n${(spins * 7 + i * 11) % 37}`);
  }
  await Promise.all(players.map((p) => p.page.waitForFunction((n) => Object.keys(window.roulette.room.game.bets).length === n, count, { timeout: 10_000, polling: 100 })));
  if (spins === 0) await players[0].page.screenshot({ path: `${outDir}/${transport}-bets.png` });
  const spinner = players[selfIds.indexOf(s.game.spinnerId)];
  await spinner.page.waitForSelector("#quick-spin:not([hidden])", { timeout: 15_000 });
  await spinner.page.click("#quick-spin");
  if (spins === 0) {
    await players[0].page.waitForTimeout(2500);
    await players[0].page.screenshot({ path: `${outDir}/${transport}-spinning.png` });
  }
  // Wait until every player has finished animating this spin.
  await Promise.all(
    players.map((p) => p.page.waitForFunction((n) => window.roulette.room.game.spun === n && !window.roulette.scene.isSpinning, s.game.spun + 1, { timeout: 25_000, polling: 200 })),
  );
  if (spins === 0) {
    await players[0].page.waitForTimeout(300);
    await players[0].page.screenshot({ path: `${outDir}/${transport}-landed.png` });
  }
  await players[0].page.waitForTimeout(1800); // the post-landing pause
}

const finals = await Promise.all(players.map(snapshot));
const key = (s) => JSON.stringify({ chips: s.game.chips, winners: s.game.winnerIds, history: s.game.history.map((h) => h.pocket) });
const consistent = finals.every((s) => key(s) === key(finals[0]));
// Chips are conserved against the payouts recorded in each spin.
const totalReturned = finals[0].game.history.reduce((sum, h) => sum + Object.values(h.results).reduce((a, r) => a + r.returned - r.staked, 0), 0);
const totalChips = Object.values(finals[0].game.chips).reduce((a, b) => a + b, 0);
const conserved = totalChips === 1000 * count + totalReturned;
await players[0].page.waitForTimeout(600);
await players[0].page.screenshot({ path: `${outDir}/${transport}-over.png` });

console.log("spins:", spins, "phase:", finals[0].game.phase, "pockets:", finals[0].game.history.map((h) => h.pocket).reverse().join(","), "chips:", finals[0].game.chips);
console.log("consistent across players:", consistent, "chips conserved:", conserved);
console.log("errors:", errors.length ? errors : "none");
await browser.close();
process.exit(consistent && conserved && finals[0].game.phase === "matchOver" && !errors.length ? 0 : 1);

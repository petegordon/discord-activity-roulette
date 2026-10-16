// End-to-end test for the spinner remote (SPINNER-REMOTE.md).
// Usage: node scripts/e2e-remote.mjs [baseUrl] [relay|peerjs]
// Expects `npm run preview` (wrangler dev) to be serving baseUrl.
//
// 1. A remote opened before anyone is at the table must not become host.
// 2. Bob (desktop, no motion) pairs a phone; the phone spins for him with
//    synthetic DeviceMotion twists and flicks, while Alice uses Quick spin.
// 3. "New link" on the table makes the old phone link stop working.
import { chromium } from "playwright-core";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const transport = process.argv[3] ?? "relay";
const room = `RMT${Date.now().toString(36).toUpperCase()}`;
const outDir = "scripts/out";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const errors = [];
const watch = (page, label) => {
  page.on("pageerror", (e) => errors.push(`[${label}] ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/is taken|Aborting|Could not connect to peer|ERR_|status of 4/.test(m.text()) && errors.push(`[${label}] console: ${m.text()}`));
};
const fail = (msg) => {
  throw new Error(msg);
};
const poll = { polling: 200 };

async function table(name) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await ctx.addInitScript((n) => localStorage.setItem("roulette.name", n), name);
  const page = await ctx.newPage();
  watch(page, name);
  await page.goto(`${base}/?room=${room}&t=${transport}&nomotion&debug`);
  await page.waitForFunction(() => window.roulette?.room?.players?.length > 0, null, { timeout: 30_000, ...poll }).catch(async (e) => {
    console.log(name, "never joined; status:", await page.textContent("#status"), "isHost:", await page.evaluate(() => window.roulette?.room?.isHost));
    throw e;
  });
  return page;
}

/** A phone: touch, mobile viewport, and a steady stream of DeviceMotion events we can steer. */
async function phone(url, label) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    // Headless Chrome has no DeviceMotionEvent; a stand-in with the same fields is enough for our reader.
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
      window.dispatchEvent(
        new DeviceMotionEvent("devicemotion", {
          acceleration: { x: m.x, y: m.y, z: m.z },
          accelerationIncludingGravity: { x: m.x, y: m.y + 9.8, z: m.z },
          rotationRate: { alpha: m.rot, beta: 0, gamma: 0 },
          interval: 16,
        }),
      );
    }, 16);
  });
  const page = await ctx.newPage();
  watch(page, label);
  await page.goto(url);
  await page.click("#r-connect");
  return page;
}

/** Hold, twist the phone to spin the wheel, then flick it forward; the flick alone launches the ball. */
async function twistAndFlick(page) {
  await page.waitForSelector("#zone.mine", { timeout: 15_000 });
  const sub = await page.textContent("#zone .zone-sub");
  if (!/twist your phone/.test(sub)) fail(`phone isn't using motion: "${sub}"`);
  const box = await page.locator("#zone").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Twist like a dial (rotation about the screen's axis), a few times over.
    for (let i = 0; i < 40; i++) {
      window.__motion = { x: 0, y: 0, z: 0, rot: i % 10 < 7 ? 450 : -200 };
      await sleep(20);
    }
    window.__motion = { x: 0, y: 0, z: 0, rot: 0 };
    await sleep(150);
    if (document.querySelector("#zone .zone-title")?.textContent !== "NOW FLICK!") throw new Error("twisting didn't get the wheel going");
    window.__motion = { x: 0, y: 0, z: -32, rot: 0 };
    await sleep(64);
    window.__motion = { x: 0, y: 0, z: 0, rot: 0 };
    await sleep(260);
  });
  // The flick, not the release, should have launched: the zone is no longer held.
  const flicked = !(await page.$("#zone.holding"));
  await page.mouse.up();
  return flicked;
}

const selfId = (page) => page.evaluate(() => window.roulette.self.id);
const game = (page) => page.evaluate(() => window.roulette.room.game);

try {
  // ---- 1. A remote that shows up first never becomes host ----
  const early = await phone(`${base}/remote?room=${room}&t=${transport}&debug#k=${randomBytes(16).toString("hex")}`, "early-phone");
  await early.waitForTimeout(1500);
  const alice = await table("Alice");
  await alice.waitForFunction(() => window.roulette.room.isHost, null, { timeout: 30_000, ...poll });
  await early.waitForSelector("#r-message:not([hidden])", { timeout: 15_000 });
  console.log("unpaired remote first: table is host, remote says:", await early.textContent("#r-msg-title"));
  await early.context().close();

  // ---- 2. Bob (not the host) pairs a phone from the lobby and plays with it ----
  const bob = await table("Bob");
  await alice.waitForFunction(() => window.roulette.room.players.length === 2, null, { timeout: 30_000, ...poll });
  await bob.click("#lobby-phone");
  await bob.waitForSelector("#pair:not([hidden]) #pair-qr svg", { timeout: 5_000 });
  const link = (await bob.textContent("#pair-link")).trim();
  if (!link.includes("/remote?") || !link.includes("#k=")) fail(`bad link ${link}`);
  await bob.screenshot({ path: `${outDir}/remote-${transport}-pair.png` });

  const remote = await phone(link, "phone");
  const bobId = await selfId(bob);
  const remoteOnline = (page, want) =>
    page.waitForFunction(([id, w]) => window.roulette.room.players.find((p) => p.id === id)?.remoteOnline === w, [bobId, want], { timeout: 30_000, ...poll });
  await remoteOnline(bob, true);
  await remoteOnline(alice, true); // everyone sees the 📱 badge
  await bob.waitForSelector("#pair", { state: "hidden", timeout: 5_000 });
  if (remote.url().includes("#")) fail("remote kept the key in the address bar");

  await alice.selectOption("#rounds", "20");
  await alice.click("#start");

  /** Play until the phone has spun `target` more times; others use Quick spin. */
  let phoneSpins = 0;
  async function play(tables, target) {
    for (let i = 0; i < 80 && phoneSpins < target; i++) {
      await bob.waitForFunction(() => window.roulette.room.game.phase === "betting", null, { timeout: 15_000, ...poll });
      const g = await game(bob);
      const prev = g.spun;
      const bobTurn = g.spinnerId === bobId;
      if (bobTurn) {
        await bob.waitForFunction(() => document.querySelector("#zone .zone-title")?.textContent === "SPIN WITH YOUR PHONE", null, { timeout: 15_000, ...poll });
        if (!(await bob.isHidden("#use-phone"))) fail("table still offers to pair while the phone is online");
        if (phoneSpins === 0) await bob.screenshot({ path: `${outDir}/remote-${transport}-table-turn.png` });
        if (!(await twistAndFlick(remote))) fail("the flick didn't launch the ball");
        await remote.waitForFunction(() => document.querySelector("#zone .zone-title")?.textContent === "No more bets", null, { timeout: 5_000, ...poll });
      } else {
        const spinner = tables.find((t) => t.id === g.spinnerId);
        await spinner.page.waitForSelector("#quick-spin:not([hidden])", { timeout: 15_000 });
        await spinner.page.click("#quick-spin");
      }
      await Promise.all(
        tables.map((t) => t.page.waitForFunction((pr) => window.roulette.room.game.spun > pr && !window.roulette.scene.isSpinning, prev, { timeout: 25_000, ...poll })),
      );
      if (bobTurn) {
        const last = (await game(bob)).history[0];
        if (last.spinner !== bobId) fail("phone spin was credited to someone else");
        await remote.waitForSelector("#r-callout.show", { timeout: 6_000 });
        const callout = await remote.textContent("#r-callout .callout-main");
        console.log(`phone spin ${++phoneSpins}: ${last.pocket} -> phone shows "${callout}"`);
        if (phoneSpins === 1) await remote.screenshot({ path: `${outDir}/remote-${transport}-phone.png` });
      }
    }
    if (phoneSpins < target) fail(`only ${phoneSpins} phone spins`);
  }
  const both = [
    { id: await selfId(alice), page: alice },
    { id: bobId, page: bob },
  ];
  await play(both, 2);
  const [ga, gb] = await Promise.all([game(alice), game(bob)]);
  if (JSON.stringify(ga.chips) !== JSON.stringify(gb.chips)) fail("tables disagree on chips");

  // ---- 3. The host leaves; Bob takes over and his phone keeps working ----
  await alice.context().close();
  await bob.waitForFunction(() => window.roulette.room.isHost && window.roulette.room.players.length === 1, null, { timeout: 60_000, ...poll });
  await remoteOnline(bob, true);
  console.log("host left: Bob is host, phone still paired");
  await play([{ id: bobId, page: bob }], 3);

  // ---- 4. New link revokes the old one ----
  await bob.click("#remote-btn");
  await bob.click("#pair-new");
  await remote.waitForSelector("#r-message:not([hidden])", { timeout: 10_000 });
  console.log("after New link, old phone says:", await remote.textContent("#r-msg-title"));
  await remoteOnline(bob, false);

  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
  process.exit(errors.length ? 1 : 0);
} catch (e) {
  console.log("FAILED:", e.message.split("\n")[0], "at line", (e.stack.match(/e2e-remote\.mjs:(\d+)/) ?? [])[1]);
  console.log("errors:", errors);
  await browser.close();
  process.exit(2);
}

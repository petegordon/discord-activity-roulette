import "./remote.css";
import { createGame, type GameState } from "../game/roulette";
import { SpinController } from "../input/controller";
import { playerIdFromKey } from "../net/identityKey";
import { PeerJsTransport } from "../net/peerjs";
import { peerOptions } from "../net/peerOptions";
import type { Player } from "../net/protocol";
import { RelayTransport } from "../net/relay";
import { Room } from "../net/room";
import type { TransportStatus } from "../net/transport";
import { apiBase, debug } from "../platform/env";
import { fmt, spinCallout } from "../ui";
import { parseRemoteLink } from "./link";

/**
 * The spinner remote: a phone browser tab that spins the wheel for a seat at
 * a table running elsewhere (Discord, a desktop). See SPINNER-REMOTE.md.
 */

/** If the host never answers a spin, give the ball back after this long. */
const SPIN_ACK_TIMEOUT_MS = 4_000;
const AFTER_LANDING_MS = 1_600;
/** Used if an older host doesn't say when the ball lands. */
const DEFAULT_LANDING_MS = 9_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function message(title: string, text: string, retry = false) {
  $("r-msg-title").textContent = title;
  $("r-msg-text").textContent = text;
  $("r-retry").hidden = !retry;
  $("r-message").hidden = false;
}

/** The key arrives in the link's fragment; keep it for refreshes, then take it out of the address bar. */
function remoteKey(room: string, fromLink: string | null): string | null {
  const storageKey = `roulette.remote.${room}`;
  try {
    if (fromLink) sessionStorage.setItem(storageKey, fromLink);
    else fromLink = sessionStorage.getItem(storageKey);
  } catch {
    // storage unavailable; a refresh will need the link again
  }
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  return fromLink;
}

function boot() {
  const params = parseRemoteLink(location.href);
  const key = params ? remoteKey(params.room, params.key) : null;
  $("r-retry").addEventListener("click", () => location.reload());
  if (!params || !key) {
    $("r-start").hidden = true;
    message("Scan the code at the table", "Open the game, tap 📱, and scan the code with this phone's camera.");
    return;
  }

  const zone = $("zone");
  let room: Room | null = null;
  let selfId = "";
  let players: Player[] = [];
  let shown: GameState = createGame();
  let gotState = false;
  let spinning = false;
  let cooling = false;
  let awaitingAck: ReturnType<typeof setTimeout> | undefined;
  let spinSeq = 0;
  let wasMyTurn = false;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;

  const hint = (text: string) => {
    $("r-hint").textContent = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => ($("r-hint").textContent = ""), 2400);
  };
  const me = () => players.find((p) => p.remoteId === selfId);
  const byId = (id: string | null) => players.find((p) => p.id === id);
  const myTurn = () => {
    const mine = me();
    return !!mine && shown.phase === "betting" && shown.spinnerId === mine.id && !spinning && !cooling && awaitingAck === undefined;
  };

  /** The dial on the phone turns with the wheel, so you can feel your twist land. */
  let dialAngle = 0;
  let dialRate = 0;
  let lastFrame = performance.now();
  function paintWheel(rate: number) {
    dialRate = rate;
  }
  const dial = $("r-dial");
  const spinDial = (now: number) => {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    dialAngle += dialRate * dt;
    dial.style.transform = `rotate(${(-dialAngle * 180) / Math.PI}deg)`;
    requestAnimationFrame(spinDial);
  };
  requestAnimationFrame(spinDial);

  // Declared first: the controller reports its motion state (and so renders) while it's being constructed.
  let controller: SpinController | null = null;
  controller = new SpinController(zone, {
    onWheel: (rate) => {
      room?.twist(rate);
      paintWheel(rate);
    },
    onLaunch: (input) => {
      awaitingAck = setTimeout(() => {
        awaitingAck = undefined;
        hint("The table didn't catch that. Try again.");
        render();
      }, SPIN_ACK_TIMEOUT_MS);
      room?.spin(input);
      render();
    },
    onHint: hint,
    onHoldChange: (holding) => zone.classList.toggle("holding", holding),
    onMotionState: () => render(),
    onStep: (step) => {
      if (step === "flick" && "vibrate" in navigator) navigator.vibrate([30, 40, 30]);
      render();
    },
  });

  function renderMe(p: Player | undefined) {
    const box = $("r-me");
    box.replaceChildren();
    if (!p) return;
    box.style.setProperty("--pc", p.color);
    let av: HTMLElement;
    if (p.avatarUrl) {
      const img = document.createElement("img");
      img.src = p.avatarUrl;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      av = img;
    } else {
      av = document.createElement("span");
      av.textContent = (p.name.trim()[0] ?? "?").toUpperCase();
    }
    av.className = "avatar";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.name;
    box.append(av, name);
  }

  function renderScores() {
    $("r-scores").replaceChildren(
      ...(shown.phase === "lobby" ? [] : shown.turnOrder)
        .map((id) => byId(id))
        .filter((p): p is Player => !!p)
        .map((p) => {
          const li = document.createElement("li");
          li.style.setProperty("--pc", p.color);
          if (p.id === shown.spinnerId && shown.phase === "betting") li.className = "spinner";
          const sw = document.createElement("span");
          sw.className = "swatch";
          const chips = document.createElement("b");
          chips.textContent = fmt(shown.chips[p.id] ?? 0);
          li.append(sw, p.name + " ", chips);
          return li;
        }),
    );
  }

  function render() {
    const mine = me();
    renderMe(mine);
    renderScores();
    if (gotState && !mine) {
      message("This link isn't active", "Tap 📱 at the table and scan the new code. This page will pick it up if the link comes back.");
    } else {
      $("r-message").hidden = true;
    }

    const turn = myTurn();
    controller?.setEnabled(turn, 0);
    if (!turn) paintWheel(0);
    if (turn && !wasMyTurn && "vibrate" in navigator) navigator.vibrate([40, 60, 40]);
    wasMyTurn = turn;

    const spinner = byId(shown.spinnerId);
    const title = zone.querySelector(".zone-title")!;
    const sub = zone.querySelector(".zone-sub")!;
    zone.classList.toggle("mine", turn);
    zone.classList.toggle("flick", turn && controller?.currentStep === "flick");
    zone.classList.toggle("waiting", !turn);
    if (mine) zone.style.setProperty("--pc", mine.color);
    const banner = $("r-banner");
    banner.replaceChildren();
    const motion = controller?.motion === "active";

    if (!gotState) {
      title.textContent = "Connecting…";
      sub.textContent = "";
    } else if (shown.phase === "lobby") {
      title.textContent = "Waiting for the game";
      sub.textContent = "The host starts it at the table";
    } else if (shown.phase === "matchOver") {
      const won = mine && shown.winnerIds.includes(mine.id);
      title.textContent = won ? "🏆 You win!" : "Game over";
      sub.textContent = "Rematch from the table";
    } else if (spinning || awaitingAck !== undefined) {
      title.textContent = "No more bets";
      sub.textContent = "Watch the wheel";
    } else if (cooling) {
      title.textContent = spinner && spinner.id !== mine?.id ? `${spinner.name} spins next` : "Get ready…";
      sub.textContent = "";
    } else if (turn) {
      const flick = controller?.currentStep === "flick";
      title.textContent = flick ? "NOW FLICK!" : "HOLD & TWIST";
      sub.textContent = flick
        ? motion ? "Hold and flick your phone forward to launch the ball" : "Hold and flick upward"
        : motion ? "Hold and twist your phone like a dial to spin the wheel" : "Hold and drag sideways";
      const b = document.createElement("b");
      b.textContent = "Your spin";
      banner.append(b, ` · spin ${shown.spun + 1} of ${shown.rounds}`);
    } else {
      title.textContent = spinner ? `${spinner.name} is spinning` : "Waiting…";
      sub.textContent = "Bet at the table";
    }
  }

  function showCallout(main: string, sub: string, tone: string) {
    const c = $("r-callout");
    c.querySelector(".callout-main")!.textContent = main;
    c.querySelector(".callout-sub")!.textContent = sub;
    c.className = `r-callout ${tone}`;
    void c.offsetWidth; // restart the animation
    c.classList.add("show");
  }

  function status(s: TransportStatus) {
    const conn = $("r-conn");
    conn.classList.toggle("ok", s.kind === "connected");
    conn.textContent = s.kind === "connected" ? "Connected" : s.kind === "failed" ? "Offline" : s.kind === "reconnecting" ? "Reconnecting…" : "Connecting…";
    if (s.kind === "failed") message("Couldn't reach the table", `${s.reason} Make sure the game is still open.`, true);
  }

  /** Keep the screen on while connected. The browser drops the lock whenever the page is hidden. */
  async function keepAwake() {
    try {
      await navigator.wakeLock?.request("screen");
    } catch {
      // not supported, or the page isn't visible
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && room) void keepAwake();
  });

  async function connect() {
    selfId = await playerIdFromKey(key!);
    const transport =
      params!.transport === "relay"
        ? new RelayTransport(params!.room, selfId, key!, apiBase, { role: "remote" })
        : new PeerJsTransport(params!.room, selfId, key!, await peerOptions(), "remote");
    const r = new Room(transport, { id: selfId, key: key!, name: "remote" }, Date.now, "remote");
    room = r;
    r.on("status", status);
    r.on("state", (p, game) => {
      players = p;
      gotState = true;
      if (!spinning) shown = game;
      render();
    });
    r.on("spun", (plan, game, landsInMs) => {
      const seq = ++spinSeq;
      clearTimeout(awaitingAck);
      awaitingAck = undefined;
      spinning = true;
      paintWheel(plan.wheel);
      render();
      // Hold the result until the ball lands at the table, so the phone doesn't spoil it.
      setTimeout(() => {
        if (seq !== spinSeq) return;
        spinning = false;
        cooling = true;
        shown = r.game;
        paintWheel(0);
        const record = game.lastSpin;
        const mine = me();
        if (record) {
          const { main, sub, tone } = spinCallout(record, players, mine?.id ?? "");
          showCallout(main, sub, `${tone} ${record.color}`);
          const res = mine ? record.results[mine.id] : undefined;
          if (res && res.returned > res.staked && "vibrate" in navigator) navigator.vibrate([60, 40, 120]);
        }
        render();
        setTimeout(() => {
          if (seq !== spinSeq) return;
          cooling = false;
          render();
        }, AFTER_LANDING_MS);
      }, landsInMs ?? DEFAULT_LANDING_MS);
    });
    if (debug) Object.assign(window, { roulette: { room: r, self: { id: selfId }, controller } });
    addEventListener("pagehide", () => r.leave());
    try {
      await r.join();
    } catch {
      // status() already explained
    }
  }

  (window as { __rouletteLoaded?: () => void }).__rouletteLoaded?.(); // see public/boot-guard.js
  $("r-connect").addEventListener("click", () => {
    // iOS only grants motion from inside a tap, so ask before anything async.
    if (controller?.motion === "needs-permission") void controller.requestMotionPermission();
    $("r-start").hidden = true;
    void keepAwake();
    render();
    void connect();
  });
  render();
}

boot();

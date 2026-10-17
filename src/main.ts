import "./style.css";
import { renderSVG } from "uqr";
import { WheelAudio } from "./audio";
import { createGame, type GameState } from "./game/roulette";
import type { Spot } from "./game/rules";
import { SpinController } from "./input/controller";
import { newIdentity } from "./net/identityKey";
import { PeerJsTransport } from "./net/peerjs";
import { peerOptions } from "./net/peerOptions";
import type { Player, SpinInput } from "./net/protocol";
import { RelayTransport } from "./net/relay";
import { Room, type Self } from "./net/room";
import type { Transport } from "./net/transport";
import { startDiscord, type DiscordSession } from "./platform/discord";
import { apiBase, debug, inDiscord, transportChoice } from "./platform/env";
import { inviteLink, standaloneRoom, storedName, storeName } from "./platform/identity";
import { remoteLink } from "./remote/link";
import { WheelScene } from "./render/scene";
import { UI } from "./ui";
import { buttonSpin } from "./wheel/spin";

/** If the host never answers a spin, give the ball back after this long. */
const SPIN_ACK_TIMEOUT_MS = 4_000;
/** Let the result callout breathe before the next spin. */
const AFTER_LANDING_MS = 1_600;
/** Don't re-send a pairing the host hasn't reflected yet more often than this. */
const REPAIR_MS = 3_000;

async function boot() {
  const audio = new WheelAudio();
  const transportKind = transportChoice();
  let roomId = "";
  let room: Room | null = null;
  let controller: SpinController | null = null;
  let discord: DiscordSession | null = null;
  /** Our spinner remote's identity, once the 📱 sheet has been opened. */
  let remote: { id: string; key: string; sentAt: number } | null = null;
  /** Chips placed this spin, newest last, for Undo. */
  let placed: { spot: Spot; amount: number }[] = [];

  const ui = new UI(
    {
      start: (rounds) => room?.start(rounds),
      rematch: () => room?.rematch(),
      quickSpin: () => {
        if (!room || !myTurn()) return;
        audio.unlock();
        launch(buttonSpin());
      },
      enableMotion: async () => {
        const ok = await controller?.requestMotionPermission();
        ui.showEnableMotion(false);
        ui.hint(ok ? "Motion on: hold and twist your phone!" : "Motion isn't available here. Drag and flick instead.");
        refresh();
      },
      toggleMute: () => {
        audio.setMuted(!audio.muted);
        audio.unlock();
        return audio.muted;
      },
      copyInvite: () => navigator.clipboard.writeText(inviteLink(roomId, transportKind)),
      bet: (spot, amount) => {
        if (!room || !bettingOpen()) return;
        audio.unlock();
        if ((shown.chips[self.id] ?? 0) < amount) {
          ui.hint("Not enough chips for that");
          return;
        }
        placed.push({ spot, amount });
        audio.hop(0.15);
        room.bet(spot, amount);
      },
      undoBet: () => {
        if (!room || !bettingOpen()) return;
        const mine = shown.bets[self.id] ?? {};
        // Skip chips the host turned down (or that were already cleared).
        while (placed.length && (mine[placed[placed.length - 1].spot] ?? 0) < placed[placed.length - 1].amount) placed.pop();
        const last = placed.pop();
        if (last) room.bet(last.spot, -last.amount);
      },
      clearBets: () => {
        if (!room || !bettingOpen()) return;
        placed = [];
        room.clearBets();
      },
      openRemote: () => void openRemote(false),
      remoteNewLink: () => void openRemote(true),
      remoteUnpair: () => {
        room?.unpair();
        remote = null;
        ui.hidePair();
      },
      remoteOpenHere: () => {
        if (remote) void discord?.openExternal(remoteLink(roomId, transportKind, remote.key)).catch(() => {});
      },
    },
    audio.muted,
  );
  document.addEventListener("pointerdown", () => audio.unlock(), { capture: true });

  // Keep the wheel in the space above the betting table.
  const footer = document.querySelector<HTMLElement>(".bottom")!;
  new ResizeObserver(() => document.documentElement.style.setProperty("--footer-h", `${footer.offsetHeight}px`)).observe(footer);
  const scene = new WheelScene(document.getElementById("stage")!);
  setInterval(() => audio.wheel(scene.wheelRate), 40);

  // ---- identity & room ----
  let self: Self;
  if (inDiscord) {
    try {
      discord = await startDiscord();
      ({ self, roomId } = discord);
    } catch (err) {
      ui.fatal(`Couldn't connect to Discord: ${(err as Error).message}`);
      return;
    }
  } else {
    roomId = standaloneRoom();
    let name = storedName();
    if (!name) {
      name = await ui.askName("");
      storeName(name);
      // iOS "Shake to Undo" keeps offering to undo the name typing even after the field is gone,
      // and pops up on every twist and flick. A reload (same room, name now saved) starts a page
      // with no typing history. Skipped if storage doesn't work, so it can't loop.
      if (storedName() === name) {
        location.reload();
        return;
      }
    }
    self = { ...(await newIdentity()), name };
  }
  ui.removeNamePrompt(); // no-op if already gone; see removeNamePrompt
  ui.setRoom(roomId, !inDiscord);
  // Discord lists the Terms and Privacy links on the app's own page; plain links can't leave the Activity frame.
  document.getElementById("legal-links")!.hidden = inDiscord;
  // Motion is blocked in Discord; there the 📱 remote page has the same link.
  document.getElementById("learn")!.hidden = inDiscord;

  ui.status({ kind: "connecting" });
  const transport: Transport =
    transportKind === "relay"
      ? new RelayTransport(roomId, self.id, self.key, apiBase, { ticket: self.ticket })
      : new PeerJsTransport(roomId, self.id, self.key, await peerOptions());
  room = new Room(transport, self);
  const r = room;

  // ---- what's on screen ----
  // `shown` lags the room's game while the ball rolls, so chips and
  // callouts never spoil a spin before it lands.
  let players: Player[] = [];
  let shown: GameState = createGame();
  let spinSeq = 0;
  let spinning = false;
  let cooling = false;
  let awaitingAck: ReturnType<typeof setTimeout> | undefined;
  let lastSpun = -1;

  const playerById = (id: string | null) => players.find((p) => p.id === id);
  const myTurn = () => shown.phase === "betting" && shown.spinnerId === self.id && !spinning && !cooling && awaitingAck === undefined;
  const bettingOpen = () => shown.phase === "betting" && !spinning;
  const me = () => playerById(self.id);
  /** Our paired phone is connected to the table right now. */
  const remoteOnline = () => !!remote && me()?.remoteId === remote.id && !!me()?.remoteOnline;
  let remoteWasOnline = false;

  /** Why the phone is the spinner here; shown on the 📱 sheet. */
  function remoteWhy() {
    if (controller?.motion === "blocked" && inDiscord) {
      return "Discord doesn't let Activities read motion sensors. Scan this with your phone's camera to spin the wheel with it.";
    }
    if (controller?.motionOff) return "Scan this with your phone's camera to spin the wheel with it.";
    return "Scan this with another phone to spin with it, handy with this device on a stand.";
  }

  function paintPair() {
    if (!remote || !ui.pairOpen) return;
    const link = remoteLink(roomId, transportKind, remote.key);
    ui.showPair({
      link,
      qrSvg: renderSVG(link, { ecc: "M", border: 1 }),
      why: remoteWhy(),
      canOpenHere: !!discord?.mobile,
      paired: me()?.remoteId === remote.id,
      online: remoteOnline(),
    });
  }

  /** Show the 📱 sheet, pairing a new remote first if we have none (or `fresh` asks for a new link). */
  async function openRemote(fresh: boolean) {
    if (!room) return;
    if (fresh || !remote) {
      const { id, key } = await newIdentity();
      remote = { id, key, sentAt: Date.now() };
      room.pair(id);
    }
    ui.openPair();
    paintPair();
  }

  /** The host may have lost our pairing (e.g. we were dropped and rejoined); quietly re-send it. */
  function keepPaired() {
    const mine = me();
    if (!remote || !mine || mine.remoteId === remote.id || Date.now() - remote.sentAt < REPAIR_MS) return;
    remote.sentAt = Date.now();
    r.pair(remote.id);
  }

  function refresh() {
    if (shown.spun !== lastSpun) {
      lastSpun = shown.spun;
      placed = [];
    }
    ui.render({ players, game: shown, selfId: self.id, hostId: r.hostId, isHost: r.isHost, bettingOpen: bettingOpen() });
    const spinner = playerById(shown.spinnerId);
    const mine = myTurn();
    // No motion here: the phone (or Quick spin) does the spinning.
    const phoneSpins = !!controller?.motionOff || remoteOnline();
    controller?.setEnabled(mine && !phoneSpins, scene.wheelRate);
    ui.showLobbyPhone(!!controller?.motionOff && !remoteOnline());
    if (shown.phase !== "betting") ui.setZone("hidden");
    else if (spinning || awaitingAck !== undefined) ui.setZone("spinning");
    else if (cooling) ui.setZone("settling", { spinnerName: spinner?.id === self.id ? undefined : spinner?.name });
    else if (mine) {
      ui.setZone(phoneSpins ? "twist" : (controller?.currentStep ?? "twist"), {
        color: spinner?.color,
        motion: controller?.motion === "active",
        remote: phoneSpins ? { online: remoteOnline(), why: "Spin with your phone, or use Quick spin" } : undefined,
      });
    } else ui.setZone("waiting", { spinnerName: spinner?.name });
    ui.showEnableMotion(mine && !phoneSpins && controller?.motion === "needs-permission");
  }

  function launch(input: SpinInput) {
    awaitingAck = setTimeout(() => {
      awaitingAck = undefined;
      ui.hint("The host didn't catch that. Try again.");
      refresh();
    }, SPIN_ACK_TIMEOUT_MS);
    refresh();
    r.spin(input);
  }

  controller = new SpinController(ui.zone, {
    onWheel: (rate) => {
      scene.setWheelRate(rate);
      r.twist(rate);
    },
    onLaunch: (input) => {
      audio.launch(input.ball);
      launch(input);
    },
    onHint: (text) => ui.hint(text),
    onHoldChange: (holding) => {
      ui.setHolding(holding);
      if (holding) scene.toHand();
    },
    onMotionState: () => refresh(),
    onStep: (step) => {
      if (step === "flick") {
        audio.ready();
        if ("vibrate" in navigator) navigator.vibrate([30, 40, 30]);
      }
      refresh();
    },
  });

  r.on("state", (p, game) => {
    players = p;
    if (!spinning) shown = game;
    keepPaired();
    const online = remoteOnline();
    if (online !== remoteWasOnline) {
      ui.hint(online ? "📱 Phone connected. Spin with it on your turn!" : "📱 Phone disconnected");
      if (online && ui.pairOpen) setTimeout(() => ui.hidePair(), 1200);
    }
    remoteWasOnline = online;
    paintPair();
    refresh();
  });

  r.on("spun", async (plan, game) => {
    const seq = ++spinSeq;
    clearTimeout(awaitingAck);
    awaitingAck = undefined;
    spinning = true;
    refresh();
    await scene.play(plan, { onHop: (hop) => audio.hop(hop.strength), onRoll: (speed) => audio.roll(speed) });
    audio.roll(0);
    if (seq !== spinSeq) return;
    spinning = false;
    cooling = true;
    shown = r.game;
    refresh();
    setTimeout(() => {
      if (seq !== spinSeq) return;
      cooling = false;
      refresh();
    }, AFTER_LANDING_MS);
    const record = game.lastSpin;
    if (record) {
      ui.announceSpin(record, players, self.id, game.phase === "matchOver");
      const mine = record.results[self.id];
      if (mine && mine.returned > mine.staked && "vibrate" in navigator) navigator.vibrate([60, 40, 120]);
    }
  });

  r.on("twist", (_from, rate) => {
    if (spinning) return;
    scene.toHand();
    scene.setWheelRate(rate);
  });

  r.on("role", () => refresh());
  r.on("status", (s) => ui.showRemoteButton(s.kind === "connected"));
  r.on("status", (s) => ui.status(s, transportKind === "peerjs" && s.kind === "failed" ? inviteLink(roomId, "relay") : undefined));

  if (debug) Object.assign(window, { roulette: { room: r, scene, self } });
  (window as { __rouletteLoaded?: () => void }).__rouletteLoaded?.(); // see public/boot-guard.js
  addEventListener("pagehide", () => r.leave());

  try {
    await r.join();
  } catch {
    // The status banner already explains what went wrong.
  }
}

void boot();

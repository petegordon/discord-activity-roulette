# Discord Activity Roulette: Plan & Specification

A multiplayer **European roulette** game with a 3D wheel. It runs **as a Discord Activity** and **as a standalone web app** at **https://roulette.housetandem.com**. Everyone bets at the same time on one shared table. The spinner **twists their phone to spin the wheel, then flicks it to launch the ball**. Every player sees the same ball land in the same pocket.

It's a sibling of [discord-activity-dice](https://github.com/petegordon/discord-activity-dice) (dice.housetandem.com) and reuses its networking, Discord, Worker and phone-remote infrastructure. Its [PLAN.md](https://github.com/petegordon/discord-activity-dice/blob/main/PLAN.md) documents those parts in depth. This file covers what's different.

**Stack:** Three.js (rendering) · DeviceMotion API (twist & flick) · PeerJS / WebRTC (peer-to-peer sync) · Cloudflare Workers with static assets + a Durable Object (hosting, Discord OAuth token exchange, WebSocket relay) · Vite + TypeScript

**Play chips only.** No real money, nothing to buy, no prizes (see the [Terms](public/terms.html)).

---

## 1. Game design (decided 2026-10-15)

| Decision | Choice |
|---|---|
| Round structure | **Shared table, rotating spinner.** Everyone starts each game with **1,000 chips**. Each spin, everyone bets at the same time until the spinner launches the ball. The spinner seat rotates in join order. |
| Match length | **10 spins** by default; the host can pick 5, 10 or 20. Most chips at the end wins; ties are shared. |
| Spin gesture | **Two steps: twist, then flick.** Hold the spin zone and twist the phone like a dial to spin the wheel, then flick the phone forward to launch the ball. |
| Wheel | **European single zero** (37 pockets). |
| Bets | **Straight-up numbers** (35:1) and **all outside bets**: red/black, odd/even, 1–18/19–36 (1:1), dozens and columns (2:1). Zero loses every outside bet. No splits, streets, corners or six-lines. |

### 1.1 Rules
- Chips are **5, 25 or 100** per tap. Tapping a spot adds the selected chip. **Undo** takes back the last chip and **Clear** takes back all of yours. At most 1,000 on one spot.
- Bets close when the spinner launches. While the ball rolls, the table is locked.
- On landing: each winning bet returns its stake plus `payout × stake`. Losing chips are gone. The table is cleared, and the next player spins.
- Players joining mid-game get 1,000 chips and go to the end of the spin order. A player who leaves gets their chips on the table back into hand. They're kept, so rejoining mid-game restores them.
- Every bet returns 36/37 of its stake on average (the house edge of a single-zero wheel). This is checked in `test/game.test.ts`.
- **Rematch**: the next player becomes first spinner, and everyone gets 1,000 chips again.

### 1.2 State (`src/game/roulette.ts`)
`GameState` holds `phase` (`lobby | betting | matchOver`), `spinnerId`, `turnOrder`, `chips` (in hand), `bets` (on the table, per player per spot), `rounds`, `spun`, `winnerIds`, `lastSpin` and `history`. A pure reducer (`placeBet`, `clearBets`, `applySpin`, …) runs on the host only.

---

## 2. The spin

### 2.1 Input (`src/input/controller.ts`, `src/input/motion.ts`)
1. **Twist.** While holding the zone, the gyroscope's rotation about the axis out of the screen (`rotationRate.alpha`) drives the wheel like a **ratchet**. Twisting faster than the wheel turns speeds it up. Twisting back to wind up again is ignored while the wheel moves, so repeated twists build speed. Otherwise the wheel coasts with friction. The wheel's speed is broadcast as `twist` (~15 Hz), so everyone sees it spin up live.
2. **Flick.** When you've twisted the wheel this turn **and** it turns at least 1 rad/s, the zone says **NOW FLICK!** (with a buzz). A flick, detected by the dice game's spike-then-stillness detector (`ShakeTracker`), launches the ball. Its strength sets how long the ball runs. Flicking first, or with a wheel that's only coasting from the last spin, shows a hint instead.
3. **Without motion** (fallback where motion permission is pending or denied): drag sideways on the zone to spin the wheel, then flick upward. Desktops and Discord use the phone remote (§4) or **Quick spin**.

### 2.2 Fair, identical results (`src/wheel/spin.ts`)
- The host picks the pocket with `crypto.getRandomValues` (rejection sampling, so every pocket is exactly 1/37). The gesture only shapes how the spin *looks*.
- The host broadcasts `spun { plan: { pocket, wheel, ball, seed }, game, landsInMs }`. `game` is the settled state, shown only once the ball lands.
- Each client builds a `BallPath`, worked out **relative to the wheel**. The ball laps the wheel against its spin, slows, drops off the rim, hops over frets (seeded, the same on every client) and settles into `pocket`. Because the path is relative, it lands correctly whatever angle that client's wheel was at, so no physics engine and no cross-device determinism are needed.
- The duration depends only on `ball` (7–9.5 s), so the host knows when the ball lands and keeps the table locked until then.

### 2.3 Rendering (`src/render/scene.ts`)
The wheel is procedural Three.js. The stator (bowl, ball track, brass deflectors) stays still. The rotor (cone, coloured pockets, number ring, frets, turret) turns. The rotor face is one canvas texture drawn top-down in polar coordinates. A gold ring marks the winning pocket. On wide screens the wheel sits left of the betting table; on phones it sits above it.

---

## 3. Networking & platform

Unchanged from the dice game except for renames: `shake` → `twist` (the only message a non-host may broadcast, rate-limited by both transports), `throw` → `spin`, `roll` → `spun`, plus `bet` and `clear-bets` to the host. The host-authoritative star, host migration, the PeerJS and relay transports, Discord room tickets, and stale-host eviction are the same code.

## 4. Spinner remote

Discord doesn't let Activities read motion sensors, so any phone can spin for a seat at the table. See [SPINNER-REMOTE.md](SPINNER-REMOTE.md).

## 5. Configuration

| Name | Where | Value |
|---|---|---|
| `VITE_DISCORD_CLIENT_ID` | `.env.production` | **Empty until the Discord app is created** |
| `DISCORD_CLIENT_ID` | `wrangler.jsonc` vars | Same |
| `DISCORD_CLIENT_SECRET` | `wrangler secret put` | From the Developer Portal |
| `VITE_PUBLIC_ORIGIN` | `.env.production` | `https://roulette.housetandem.com` (where phones open the remote from inside Discord) |

## 6. Build status (2026-10-15)

| Item | Status |
|---|---|
| Rules, reducer, payouts, host | ✅ Unit-tested (`npm test`) |
| Ball path lands in the host's pocket for any wheel angle/direction/speed/seed | ✅ Unit-tested |
| Twist ratchet, flick launch, phone remote | ✅ e2e with synthetic DeviceMotion (`scripts/e2e-remote.mjs`), relay and PeerJS |
| Multiplayer betting & spins, chips conserved, all players agree | ✅ e2e (`scripts/e2e.mjs`), relay and PeerJS |
| Real phones | 🟡 Not yet tried. Twist uses `rotationRate.alpha`; confirm on iPhone and Android that it's the screen-normal axis |
| Discord Activity | 🟡 Needs a Discord application (ID + secret) and URL mappings, as for the dice app |
| Deploy | ✅ Live at https://roulette.housetandem.com (also https://discord-activity-roulette.pete-872.workers.dev); e2e passes against production on both transports |

## 7. Ideas not in v1 (need a design decision first)
- Split/street/corner bets, "repeat last bet", a bet timer, and per-player win streak callouts.
- Throw calibration (🎯) from the dice game, adapted to the flick.

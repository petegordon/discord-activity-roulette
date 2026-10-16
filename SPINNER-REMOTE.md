# Spinner Remote

Use a phone's browser to spin the wheel for a seat at a table running where motion can't reach: a Discord Activity, a desktop browser, or a device without motion sensors.

This is the dice game's [Shaker Remote](https://github.com/petegordon/discord-activity-dice/blob/main/SHAKER-REMOTE.md) with the gesture swapped. The design and security model are the same, and that document has the full reasoning.

## Why

Discord runs Activities in a cross-origin iframe that isn't delegated the `accelerometer` and `gyroscope` Permissions Policy features, so `devicemotion` never fires there and a frame can't turn it back on. A phone's own browser tab is a top-level page, so motion works there.

## At the table

- Without motion, your turn shows **📱 Spin with your phone** and a smaller **Quick spin**. In the lobby, **📱 Spin with your phone** offers to pair before the game starts.
- **📱** opens a sheet with a QR code (made locally with `uqr`), the full link, **Copy link**, and, in Discord on a phone, **Open on this phone** (`openExternalLink`).
- Once the phone connects, everyone sees a 📱 badge on your chip and the sheet closes.
- **New link** revokes the old one; **Unpair** stops using the phone.

## On the phone (`/remote`)

- **Tap to connect** (this also asks for motion permission on iPhone, from inside the tap).
- On your turn: **HOLD & TWIST**. A little wheel on the phone turns with your twist while the real one turns on the table. Then **NOW FLICK!** launches the ball.
- The phone shows the result only once the ball lands at the table (`landsInMs`), so it never spoils the spin.
- It keeps the screen awake while connected.

## Identity, pairing, and what a remote may do

- The table makes a random key; the remote's id is derived from it (`src/net/identityKey.ts`). The key travels in the link's `#` fragment, which browsers never send to servers, and the remote moves it to `sessionStorage` and out of the address bar.
- The host binds the remote id to the player (`pair` / `unpair`). A remote belongs to one player at a time.
- A remote can only ask for the state (`remote-hello`), `twist` (cosmetic, only relayed while its player is the spinner) and `spin` for its player on their turn. It can't bet, join as a player, or become host. Both transports mark remote connections; the sender can't claim it.
- Anyone with the link can spin for you, so the sheet warns not to show the code on a stream.

## Tests

`scripts/e2e-remote.mjs` (relay and PeerJS):
1. A remote that connects before anyone is at the table never becomes host.
2. Bob pairs a phone from the lobby. The phone twists (synthetic `rotationRate.alpha`), sees **NOW FLICK!**, flicks, and the spin is credited to Bob. The phone shows the same result.
3. The host leaves; Bob takes over and his phone keeps working.
4. **New link** makes the old phone link stop working.

# PlayMotion — Architecture

## Overview

```
┌────────────────────┐         WebSocket /ws          ┌────────────────────┐
│  Phone (mobile.html)│  ── hand landmarks 30 Hz ──►  │  TV (tv.html)      │
│  MediaPipe Hands     │  ◄── state/cmd/preview ────  │  Game host (Canvas)│
└────────────────────┘                                └────────────────────┘
        │                                                      │
        └──── same-origin HTTP(S) server (server/index.js) ─────┘
```

Everything is same-origin: the server serves the pages, the WebSocket relay and
the `/api/net` discovery endpoint. No build step; the browser loads ES modules
directly.

## Server (`server/`)

- `index.js` — HTTP on `PORT` (8080), HTTPS on `HTTPS_PORT` (8443) with a
  self-signed cert. Static files + `/api/net`, `/api/health`, `/ws`.
- `rooms.js` — `RoomRegistry`: 4-letter room codes, TV reclaim on refresh,
  orphan TTL, GC.
- `static.js` — static handler with pretty routes (`/tv`, `/m`, `/m/CODE`),
  MIME types, long-cache for `/vendor/`.
- `tls.js` — `selfsigned` cert generation with SANs for LAN IPs.
- `tunnel.js` — optional Cloudflare quick tunnel wrapper.

The relay is **dumb**: it forwards `{t:'peer', data}` between the two peers and
answers app-level pings. It never inspects payloads.

## Shared (`public/js/shared/`)

- `protocol.js` — `MSG`, `CMD`, `SCREEN`, `LM`, `HAND_BONES`, `handsPacket`,
  `isValidHands`.
- `util.js` — `clamp`, `damp`, `mapRange`, `OneEuro`, `formatScore`, `store`,
  `Emitter`, `onResize`.
- `net.js` — `Relay` client: reconnect, presence, RTT pings, welcome handshake.

## TV (`public/js/tv/`)

- `app.js` — screen router, pairing/QR, calibration, settings, high scores,
  HUD, pointer layer, keyboard/gamepad/mouse, phone command handling.
- `ui.js` — `UiNav`: spatial focus, hand dwell-to-select, hover rings.
- `game/engine.js` — `Game` host: canvas, rAF loop, view, effects, pointers,
  game switching, pause/resume.
- `game/config.js` — fruit types, physics, rules, difficulty curve.
- `game/pointers.js` — `PointerManager`: hand/mouse/pad → smoothed blades with
  velocity gate (`SLICE_SPEED` 880 px/s, hysteresis 620).
- `game/fruit.js` — `Fruit`, `Half`, `Spawner`, hit geometry.
- `game/art.js` — procedural fruit sprites (whole + cut halves), bomb spark,
  baked dojo background.
- `game/effects.js` — particles, decals, popups, rings, shake, flash.
- `game/audio.js` — synthesized Web Audio (taiko/koto loop, SFX, reverb).
- `game/slice.js` — `BladeTrail`, `drawCursor`.
- `games/*.js` — pluggable game modules (fruitninja, whackamole, starcatcher,
  balloonpop, colorrush). Each exports `createX()` returning
  `{id, title, state, init, start, update, render, isOver, mode}`.

## Phone (`public/js/mobile/`)

- `main.js` — app flow, camera + tracking boot, TV state mirror, buttons.
- `tracker.js` — `HandTracker`: MediaPipe HandLandmarker (GPU/CPU), One Euro
  smoothing, synthetic `?fake=1` source.
- `overlay.js` — `Overlay`: mirrored video + skeleton + slice-power trail.

## Data flow

1. Phone: `getUserMedia` → video → `detectForVideo` → smoothed landmarks →
   `handsPacket` → `relay.send` (WS).
2. Server: forwards to the paired TV socket as `{t:'peer', data}`.
3. TV: `isValidHands` → `PointerManager.ingestHands` → `mapPoint` (calibration
   ranges) → One Euro smoothing → velocity gate → `blades()`.
4. Engine: `_updateGame` runs spawner + physics; for each blade, if armed,
   pushes a `BladeTrail` and runs `_checkHits` (segment-circle).
5. `_slice` updates state, emits `slice`/`miss`/`bomb`/`gameover` → app.js
   updates HUD, audio, effects, and broadcasts `STATE` to the phone.

## Coordinate mapping

Camera normalized coords (0..1, origin top-left) → `PointerManager.mapPoint`:
- Apply calibration ranges (min/max observed during calibration) with sensitivity.
- Mirror horizontally when `mirror` is on (so the player's right hand moves right).
- Scale to 1920×1080 logical space; clamp.

## State machine

Screens: `menu` → `hub` → `pair` (if no phone) → `calib` (Fruit Ninja only) →
`playing` ⇄ `gameover`. Overlays: `pause`, `over`, `howto`, `settings`.

## Persistence

`localStorage` under `fn.*`: settings, best scores per game (`best.<id>`),
selected game, mobile flip preference. Room code in `sessionStorage`.

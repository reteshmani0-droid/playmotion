# PlayMotion — Motion-Controlled Active Play

A Nex-Playground-style active-play console that runs in any modern TV browser.
Your **TV runs the game**; your **phone is the camera and hand tracker** (no app
install). Five games are included: Fruit Ninja, Whack-a-Mole, Star Catcher,
Balloon Pop and Color Rush. All tracking happens on the phone; only hand
positions (~600 bytes/frame) are sent to the TV.

## Quick start

```bash
# 1. Install dependencies (Node 18+)
npm install

# 2. Start the game server (HTTP :8080, HTTPS :8443)
npm start

# 3. Open on your TV / PC
#    http://<your-computer>:8080/tv
#    (or http://localhost:8080/tv on the same machine)

# 4. On the TV, press PLAY, then scan the QR code with your phone.
#    The phone opens https://<your-ip>:8443/m?c=XXXX automatically.

# 5. Allow the camera, prop the phone 2-3 m away facing you, and play.
```

Mouse / keyboard / gamepad work without a phone: open `/tv?auto=1` for an
instant mouse-mode practice round, or use the menu's "TRY IT WITH A MOUSE".

## Platform support

| Platform | Supported | Notes |
|---|---|---|
| Windows / macOS / Linux PC | ✅ | Any Chromium/Firefox/Safari browser |
| Smart TV browser (Samsung Tizen, LG webOS) | ✅ | Use the TV's built-in browser; open `/tv` |
| Google TV / Android TV | ✅ | Chrome; full support |
| Amazon Fire TV | ✅ | Silk browser; camera-less TV is fine (phone is the camera) |
| Apple TV | ⚠️ AirPlay only | tvOS has no general-purpose browser. Mirror a Mac/iPhone browser via AirPlay, or run the game on a PC connected to the TV |
| Roku | ❌ | No general browser; not supported. Use a PC/Chromecast/Fire Stick instead |

Camera access on phones requires a **secure context** (HTTPS). The server provides
a self-signed HTTPS listener on `:8443` automatically; the TV's QR code always
points at the HTTPS URL. For the smoothest experience on iOS, either accept the
certificate once or use `npm run tunnel` (free Cloudflare quick tunnel, no
account).

## Requirements

- Node.js 18 or newer (`node --version`)
- A TV or monitor and a smartphone on the same Wi-Fi network
- Good lighting; stand 2-3 m back so the phone sees both hands

## How it works

```
Phone (camera) ──MediaPipe Hands──► hand landmarks ──WebSocket──► TV (game)
   getUserMedia        (local, 30 Hz)        (~600 B/frame)        Canvas 2D
```

1. The phone runs MediaPipe Hand Landmarker locally (GPU, CPU fallback).
2. Only 21 smoothed landmark pairs per hand are sent — never video (except a
   tiny 192×144 preview during setup).
3. The TV maps hand positions into the 1920×1080 play field, applies One Euro
   smoothing, velocity-gates slicing, and runs the simulation at 60 FPS.

## Games

| Game | How to play |
|---|---|
| Fruit Ninja | Swipe fast through fruit. Bombs end the run. 3 missed fruit = game over |
| Whack-a-Mole | Tap the moles before they sink. Bombs end the run |
| Star Catcher | Move your hands to catch falling stars and gems. Avoid bombs |
| Balloon Pop | Pop rising balloons. Bombs end the run |
| Color Rush | Touch only the targets matching the prompt color |

## Controls

- **Hands (phone camera)** — primary input
- **Mouse** — hold left button and drag to slice / tap
- **Keyboard** — arrows move focus, Enter/Space select, Esc pause/back, M mute, F fullscreen
- **Gamepad** — D-pad navigate, A select, B back, right stick as a fallback blade

## Calibration

Open PLAY → pick Fruit Ninja → the calibration screen appears. Sweep both hands
around the glowing frame; the playable area locks automatically once coverage
reaches 100%. You can skip calibration (uses the last saved area) or reset it
from Settings.

## Settings

Music/SFX mute + volume, slice sensitivity, mirror movement, camera preview,
reduce effects (lower particle counts), recalibrate, fullscreen, reset scores.

## Troubleshooting

- **"Camera unavailable" / no camera permission** — phones only allow
  `getUserMedia` on HTTPS. Scan the QR code on the TV (it uses `https://`), or
  run `npm run tunnel`.
- **iOS certificate warning** — open the HTTPS URL once, tap "Advanced" →
  "Proceed to (unsafe)". Or use `npm run tunnel` for a trusted URL.
- **"Room not found"** — the TV must be on the pairing or hub screen. Reload
  both pages.
- **No hands detected** — improve lighting, remove backlighting, keep hands in
  frame, stand 2-3 m back.
- **Low FPS** — enable "Reduce effects" in Settings; close other tabs.

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md). The same server runs unchanged on Render,
Fly, Railway or any Node host. Set `PUBLIC_URL=https://your-host` to override
the phone URL.

## Project layout

```
server/        index.js, rooms.js, static.js, tls.js, tunnel.js
public/        index.html, tv.html, mobile.html
  css/         tv.css, mobile.css, landing.css
  js/shared/   protocol.js, util.js, net.js
  js/tv/       app.js, ui.js, game/engine.js, game/*.js, games/*.js
  js/mobile/   main.js, tracker.js, overlay.js
  vendor/      mediapipe/, qrcode.js
test/          smoke.js
```

## Performance targets

- 60 FPS on a mid-range TV browser (Canvas 2D, fixed 1920×1080 logical space)
- < 25 KB/s network per phone (30 Hz × ~600 B)
- < 150 ms glass-to-glass latency on LAN
- Offline-capable after first load (MediaPipe + WASM vendored locally)

## Privacy

No video leaves the phone for gameplay. The server only relays landmark packets
between the paired TV and phone. No accounts, no analytics, no cloud processing.
AI tracking runs entirely on-device.

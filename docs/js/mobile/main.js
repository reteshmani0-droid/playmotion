/**
 * Phone remote app.
 *
 * Flow: scan QR → join room → allow camera → MediaPipe hand tracking runs
 * locally → 21 landmarks per hand stream to the TV at 30 Hz. Video never leaves
 * the phone for gameplay (only a tiny 192×144 preview during setup).
 */
import { Relay } from '../shared/net.js';
import { MSG, CMD, handsPacket } from '../shared/protocol.js';
import { HandTracker } from './tracker.js';
import { Overlay } from './overlay.js';
import { clamp, store } from '../shared/util.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const roomCode = (params.get('c') || params.get('code') || '').trim().toUpperCase();
const fakeMode = params.get('fake') === '1';

const els = {
  conn: $('conn'),
  connText: $('conn-text'),
  cameraGate: $('camera-gate'),
  codeGate: $('code-gate'),
  loading: $('loading'),
  loadingText: $('loading-text'),
  loadingBar: $('loading-bar'),
  errorGate: $('error-gate'),
  errorTitle: $('error-title'),
  errorText: $('error-text'),
  errorFine: $('error-fine'),
  retry: $('btn-retry'),
  start: $('btn-start'),
  scoreHud: $('score-hud'),
  score: $('m-score'),
  lives: $('m-lives'),
  action: $('btn-action'),
  fps: $('m-fps'),
  hands: $('m-hands'),
  power: $('power'),
  powerFill: $('power-fill'),
  banner: $('banner'),
  tip: $('tip'),
  switch: $('btn-switch'),
  cal: $('btn-cal'),
  flip: $('btn-flip'),
  disconnect: $('btn-disconnect'),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let relay = null;
let tracker = null;
let overlay = null;
let wantPreview = false;
let seq = 0;
let lastPreviewAt = 0;
let lastStatusAt = 0;
let lastHandsCount = 0;
let lastSpeed = 0;
let lastTelemetryAt = 0;
let errorKind = 'camera';
let bannerTimer = 0;
let wakeLock = null;
let tvState = { screen: 'menu', paused: false, score: 0, lives: 3, combo: 0, best: 0 };
let warnedNoPeer = false;

// Tiny canvas used for the setup preview stream.
const previewCanvas = document.createElement('canvas');
previewCanvas.width = 192;
previewCanvas.height = 144;
const previewCtx = previewCanvas.getContext('2d');

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setConn(kind, text) {
  els.conn.className = `conn ${kind}`;
  els.connText.textContent = text;
}

function banner(text, ms = 2400) {
  if (!text) {
    els.banner.classList.remove('show');
    return;
  }
  els.banner.textContent = text;
  els.banner.classList.add('show');
  clearTimeout(bannerTimer);
  if (ms > 0) bannerTimer = setTimeout(() => els.banner.classList.remove('show'), ms);
}

function showLoading(text, pct) {
  els.loading.hidden = false;
  els.loadingText.textContent = text;
  if (pct != null) els.loadingBar.style.width = `${pct}%`;
}

function hideLoading() {
  els.loadingBar.style.width = '100%';
  setTimeout(() => {
    els.loading.hidden = true;
  }, 220);
}

function showError(title, text, fine = '', kind = 'camera') {
  errorKind = kind;
  els.loading.hidden = true;
  els.cameraGate.hidden = true;
  els.errorGate.hidden = false;
  els.errorTitle.textContent = title;
  els.errorText.textContent = text;
  els.errorFine.textContent = fine;
}

function cameraErrorMessage(err) {
  const name = err?.name || '';
  if (!window.isSecureContext) {
    return {
      title: 'HTTPS needed for camera',
      text: 'Phones only allow the camera on a secure page. Scan the QR code on the TV again (it uses https://).',
      fine: 'Using a home server? Accept the certificate warning once, or run “npm run tunnel” on the computer.',
    };
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      title: 'Camera permission blocked',
      text: 'Allow camera access for this site, then tap Try Again.',
      fine: 'iPhone: Settings → Safari → Camera → Allow · Chrome: lock icon → Permissions → Camera.',
    };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return {
      title: 'No camera found',
      text: 'This browser could not find a camera. Close other camera apps and try again.',
      fine: 'If you are testing on a computer, use ?fake=1 to simulate hands.',
    };
  }
  if (name === 'NotReadableError') {
    return {
      title: 'Camera is busy',
      text: 'Another app or tab is using the camera. Close it and tap Try Again.',
    };
  }
  if (name === 'NotSupportedError') {
    return {
      title: 'Browser not supported',
      text: 'This browser cannot access the camera. Open the link in Safari or Chrome.',
    };
  }
  return {
    title: 'Camera could not start',
    text: err?.message || 'Unknown camera error.',
    fine: 'Try reloading this page.',
  };
}

// ---------------------------------------------------------------------------
// Camera + tracking boot
// ---------------------------------------------------------------------------

async function startCameraFlow() {
  if (fakeMode) {
    els.cameraGate.hidden = true;
    els.loading.hidden = true;
    tracker.startFake();
    overlay.draw(null, performance.now());
    banner('FAKE HANDS MODE · dev simulation', 0);
    return;
  }

  els.cameraGate.hidden = true;
  els.errorGate.hidden = true;
  showLoading('Starting camera…', 16);

  // Fullscreen hides browser chrome and keeps the viewfinder big.
  try {
    await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
  } catch {}

  try {
    const camPromise = tracker.openCamera('user');
    const modelPromise = tracker.initModel();
    camPromise.catch(() => {});
    modelPromise.catch(() => {});

    await camPromise;
    showLoading('Loading hand tracking…', 52);
    await modelPromise;
    showLoading('Warming up…', 92);
    await new Promise((r) => setTimeout(r, 120));

    tracker.start();
    overlay.resize();
    hideLoading();
    requestWakeLock();
    banner('Tracking ready · wave your hands', 2600);
    sendStatus(true);
    if (relay && !relay.paired && !warnedNoPeer) {
      warnedNoPeer = true;
      setTimeout(() => banner('TV not connected — check the game is open', 3200), 2800);
    }
  } catch (err) {
    console.error('camera start failed', err);
    const msg = cameraErrorMessage(err);
    showError(msg.title, msg.text, msg.fine, 'camera');
    tracker.stop();
    tracker.stopStream();
  }
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => {
        wakeLock = null;
      });
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Frame pipeline
// ---------------------------------------------------------------------------

function onFrame(frame) {
  const now = performance.now();
  lastHandsCount = frame.hands.length;
  lastSpeed = frame.hands.reduce((m, h) => Math.max(m, h.speed || 0), 0);

  overlay.draw(frame, now);

  if (now - lastTelemetryAt > 220) {
    lastTelemetryAt = now;
    els.fps.textContent = `${frame.fps || 0} FPS`;
    els.hands.textContent = frame.hands.length
      ? `${frame.hands.length} HAND${frame.hands.length > 1 ? 'S' : ''}`
      : 'NO HANDS';
    const pct = Math.round(clamp(lastSpeed / 1.15, 0, 1) * 100);
    els.powerFill.style.width = `${pct}%`;
    els.power.classList.toggle('hot', pct > 52);
  }

  if (!relay || !relay.paired) return;

  const packet = handsPacket(
    frame.hands.map((h) => ({
      hand: h.hand,
      score: h.score,
      palm: h.palm,
      tip: h.tip,
      span: h.span,
      speed: h.speed,
      pts: h.pts,
    })),
    { w: frame.w, h: frame.h, ts: frame.ts, fps: frame.fps, seq: seq++ },
  );
  relay.send(packet);

  if (wantPreview && now - lastPreviewAt > 250) {
    lastPreviewAt = now;
    sendPreview();
  }

  if (now - lastStatusAt > 1200) {
    lastStatusAt = now;
    sendStatus(false);
  }
}

function sendPreview() {
  const video = tracker?.video;
  if (!video || video.readyState < 2 || !video.videoWidth) return;
  try {
    previewCtx.drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height);
    const jpeg = previewCanvas.toDataURL('image/jpeg', 0.42).split(',')[1];
    if (jpeg) relay.send({ t: MSG.PREVIEW, jpeg, w: previewCanvas.width, h: previewCanvas.height });
  } catch {}
}

function sendStatus(force) {
  if (!relay || !relay.paired) return;
  relay.send({
    t: MSG.STATUS,
    camera: Boolean(tracker?.stream) || fakeMode,
    tracking: tracker?.running ? 'ok' : 'idle',
    fps: tracker?.fps || 0,
    hands: lastHandsCount,
    delegate: tracker?.delegate || 'none',
    error: null,
  });
  if (force) lastStatusAt = performance.now();
}

// ---------------------------------------------------------------------------
// TV state mirror
// ---------------------------------------------------------------------------

function applyTvState() {
  const playing = ['playing', 'paused', 'gameover'].includes(tvState.screen);
  document.body.classList.toggle('body-playing', playing);

  els.score.textContent = String(tvState.score ?? 0);
  const lives = tvState.lives ?? 3;
  if (els.lives.children.length !== 3) {
    els.lives.innerHTML = '<i>✕</i>'.repeat(3);
  }
  [...els.lives.children].forEach((el, i) => el.classList.toggle('lost', i >= lives));

  const calibrating = tvState.screen === 'calibration' || tvState.screen === 'calib';
  const pairing = tvState.screen === 'pairing' || tvState.screen === 'pair';

  let label = 'START GAME';
  if (tvState.screen === 'gameover') label = 'PLAY AGAIN';
  else if (tvState.paused) label = 'RESUME';
  else if (tvState.screen === 'playing') label = 'PAUSE';
  else if (calibrating) label = 'START SLICING';
  els.action.textContent = label;

  switch (true) {
    case calibrating:
      banner('CALIBRATION ON TV\nSweep your hands around the frame', 0);
      els.tip.textContent = 'Stand 2–3 m back so the phone sees both of your hands.';
      break;
    case tvState.screen === 'playing':
      if (tvState.paused) {
        banner('PAUSED', 0);
      } else {
        banner('');
      }
      els.tip.textContent = 'Move fast to slice. Two hands = two blades. Avoid bombs!';
      break;
    case tvState.screen === 'gameover':
      banner('GAME OVER\nTap Play Again on either screen', 0);
      els.tip.textContent = 'Nice run. Swipe on the TV or tap Play Again.';
      break;
    case pairing:
      banner('PAIRING\nFollow the TV to connect', 0);
      break;
    case tvState.screen === 'hub':
      banner('PICK A GAME\nOn your TV', 0);
      els.tip.textContent = 'Choose a game on the TV with your hand or remote.';
      break;
    default:
      banner('');
      els.tip.textContent = 'Press PLAY on your TV to start a round.';
  }
}

// ---------------------------------------------------------------------------
// Relay wiring
// ---------------------------------------------------------------------------

function initRelay() {
  relay = new Relay({ role: 'mobile', code: roomCode, transport: new URLSearchParams(location.search).get('transport') || 'auto' });

  relay.on('status', ({ state }) => {
    if (state === 'connecting') setConn('', 'CONNECTING');
    else if (state === 'reconnecting') setConn('dead', 'RECONNECTING');
    else if (state === 'waiting') setConn('', 'WAITING FOR TV');
    else if (state === 'ready') setConn('live', 'CONNECTED');
    else if (state === 'closed') setConn('dead', 'DISCONNECTED');
    else if (state === 'error') setConn('dead', 'CONNECTION ERROR');
  });

  relay.on('welcome', (msg) => {
    setConn(msg.peer ? 'live' : '', msg.peer ? 'CONNECTED' : 'WAITING FOR TV');
    relay.send({
      t: MSG.HELLO_MOBILE,
      info: {
        ua: navigator.userAgent.slice(0, 140),
        dpr: window.devicePixelRatio,
        screen: [window.innerWidth, window.innerHeight],
        fake: fakeMode,
      },
    });
    if (!msg.peer) {
      banner('TV not connected\nMake sure the game is open on your TV', 4200);
    } else {
      banner('Connected to TV', 1800);
    }
    sendStatus(true);
  });

  relay.on('peer', ({ present }) => {
    if (present) {
      setConn('live', 'CONNECTED');
      banner('Connected to TV', 1800);
      warnedNoPeer = false;
      sendStatus(true);
    } else {
      setConn('', 'WAITING FOR TV');
      banner('TV disconnected\nReopen the game on your TV', 4000);
    }
  });

  relay.on('fatal', (msg) => {
    const notFound = msg.code === 'ROOM_NOT_FOUND';
    showError(
      notFound ? 'Room not found' : 'Connection error',
      notFound
        ? 'That 4-letter code is not active. Check the code on your TV and scan again.'
        : msg.message || 'The relay refused the connection.',
      'The TV must be showing the pairing screen.',
      'relay',
    );
    setConn('dead', 'ERROR');
    tracker?.stop();
  });

  relay.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === MSG.STATE) {
      tvState = {
        screen: msg.screen || 'menu',
        paused: Boolean(msg.paused),
        score: msg.score || 0,
        lives: msg.lives ?? 3,
        combo: msg.combo || 0,
        best: msg.best || 0,
      };
      applyTvState();
      return;
    }
    if (msg.t === MSG.WANT_PREVIEW) {
      wantPreview = Boolean(msg.on);
      return;
    }
    if (msg.t === MSG.FX) {
      if (msg.kind === 'combo') navigator.vibrate?.(18);
      else if (msg.kind === 'bomb') navigator.vibrate?.([70, 50, 120]);
      return;
    }
    if (msg.t === MSG.CMD) {
      if (msg.cmd === 'vibrate') navigator.vibrate?.(30);
      return;
    }
  });

  relay.connect();

  // Debug hook for QA (harmless).
  window.__relay = relay;
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

els.start.addEventListener('click', () => {
  startCameraFlow();
});

els.retry.addEventListener('click', () => {
  if (errorKind === 'relay') {
    location.reload();
    return;
  }
  els.errorGate.hidden = true;
  startCameraFlow();
});

els.action.addEventListener('click', () => {
  if (!relay) return;
  if (tvState.paused) relay.send({ t: MSG.CMD, cmd: CMD.RESUME });
  else if (tvState.screen === 'playing') relay.send({ t: MSG.CMD, cmd: CMD.PAUSE });
  else if (tvState.screen === 'gameover') relay.send({ t: MSG.CMD, cmd: CMD.RESTART });
  else relay.send({ t: MSG.CMD, cmd: CMD.START });
});

els.cal.addEventListener('click', () => {
  if (!relay?.paired) {
    banner('Connect to your TV first', 2200);
    return;
  }
  relay.send({ t: MSG.CMD, cmd: CMD.CALIBRATE });
  banner('Calibrating on TV\nFollow the frame instructions', 3000);
});

els.switch.addEventListener('click', async () => {
  if (fakeMode) {
    banner('Switch camera unavailable in fake mode', 2000);
    return;
  }
  els.switch.disabled = true;
  try {
    const facing = await tracker.switchCamera();
    banner(facing === 'user' ? 'Front camera' : 'Back camera', 1800);
    if (facing === 'environment') {
      setTimeout(() => banner('Back camera faces away from you — use it only if the TV is behind the phone', 3600), 1900);
    }
  } catch (err) {
    banner('Could not switch camera', 2200);
  } finally {
    els.switch.disabled = false;
  }
});

els.flip.addEventListener('click', () => {
  overlay.flip = !overlay.flip;
  store.set('mobile.flip', overlay.flip);
  els.flip.textContent = overlay.flip ? 'FLIP PREVIEW ON' : 'FLIP PREVIEW OFF';
});

els.disconnect.addEventListener('click', () => {
  relay?.close(false);
  tracker?.stop();
  tracker?.stopStream();
  try {
    wakeLock?.release();
  } catch {}
  setConn('dead', 'DISCONNECTED');
  showError(
    'Disconnected',
    'Your phone stopped sending hand tracking to the TV.',
    'Reload this page to pair again.',
    'relay',
  );
});

// Code entry gate.
const codeForm = $('code-form');
const codeInput = $('code-input');
if (codeInput) {
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });
  codeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = codeInput.value.trim().toUpperCase();
    if (value.length !== 4) {
      codeInput.focus();
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set('c', value);
    location.replace(url.toString());
  });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    requestWakeLock();
    if (tracker?.running) sendStatus(true);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  overlay = new Overlay($('overlay'), $('cam'));
  overlay.flip = store.get('mobile.flip', true) !== false;
  els.flip.textContent = overlay.flip ? 'FLIP PREVIEW ON' : 'FLIP PREVIEW OFF';
  overlay.observe();

  tracker = new HandTracker({
    video: $('cam'),
    onFrame,
    onStatus: (status) => {
      if (status.error) {
        showError('Tracking error', status.error, 'Try reloading the page.', 'camera');
      }
      if (status.facing) {
        els.switch.textContent = status.facing === 'user' ? 'FRONT CAMERA' : 'BACK CAMERA';
      }
    },
  });

  applyTvState();

  if (!roomCode) {
    els.cameraGate.hidden = true;
    els.codeGate.hidden = false;
    setConn('', 'NOT PAIRED');
    $('code-input')?.focus();
    // Keep the overlay idle animation alive behind the code gate.
    const idle = () => {
      overlay.draw(null, performance.now());
      requestAnimationFrame(idle);
    };
    requestAnimationFrame(idle);
    return;
  }

  if (!window.isSecureContext) {
    // Explain before the user taps anything.
    showError(
      'HTTPS needed for camera',
      'Phones only allow camera access on a secure page. Scan the QR code on the TV again — it opens the https:// address.',
      'On a home server: accept the certificate warning once. Or run “npm run tunnel”.',
      'camera',
    );
  }

  initRelay();

  if (fakeMode) {
    els.start.textContent = 'START SIMULATION';
  }

  if ('serviceWorker' in navigator) {
    // Not required; no offline cache to avoid stale game builds.
  }
}

boot();

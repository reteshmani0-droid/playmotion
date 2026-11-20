/**
 * TV application shell.
 *
 * Owns: screen routing, phone pairing (QR + room code), calibration, settings,
 * high scores, HUD, and the pointer layer that lets you select menu items by
 * hovering your hand.
 *
 * The simulation itself lives in game/engine.js.
 */
import { Game, GAME_LIST } from './game/engine.js';
import { AudioEngine } from './game/audio.js';
import { Relay } from '../shared/net.js';
import { MSG, CMD, SCREEN, isValidHands } from '../shared/protocol.js';
import { clamp, store, formatScore, onResize } from '../shared/util.js';
import { UiNav } from './ui.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Settings + persistent scores
// ---------------------------------------------------------------------------

const DEFAULT_RANGES = { x0: 0.14, x1: 0.86, y0: 0.1, y1: 0.82 };

const DEFAULT_SETTINGS = {
  music: true,
  sfx: true,
  musicVolume: 0.34,
  sfxVolume: 0.75,
  sensitivity: 1,
  mirror: true,
  preview: true,
  reduceFx: false,
  calibrated: null,
};

const settings = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };
if (settings.calibrated) {
  const c = settings.calibrated;
  if (![c.x0, c.x1, c.y0, c.y1].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    settings.calibrated = null;
  }
}

let bestScore = Number(store.get('best', 0)) || 0;
let bestCombo = Number(store.get('bestCombo', 0)) || 0;
let selectedGameId = String(store.get('selectedGame', 'fruitninja') || 'fruitninja');
let soloCamera = Boolean(store.get('soloCamera', false));
let soloTracker = null;
let soloVideo = null;

function bestFor(id) { return Number(store.get(`best.${id}`, 0)) || 0; }
function setBestFor(id, v) { store.set(`best.${id}`, v); }

// ---------------------------------------------------------------------------
// Core objects
// ---------------------------------------------------------------------------

const audio = new AudioEngine();
const game = new Game({
  canvas: $('stage'),
  audio,
  settings,
  onEvent: onGameEvent,
});
game.pointers.setRanges(settings.calibrated || DEFAULT_RANGES);
game.pointers.setSensitivity(settings.sensitivity);
game.pointers.mirror = settings.mirror;

const ui = new UiNav();
const pointerCanvas = $('pointers');
const pctx = pointerCanvas.getContext('2d');

const relay = new Relay({
  role: 'tv',
  code: sessionStorage.getItem('fn.room') || null,
  transport: new URLSearchParams(location.search).get('transport') || 'auto',
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const screens = {
  menu: $('screen-menu'),
  hub: $('screen-hub'),
  pair: $('screen-pair'),
  calib: $('screen-calib'),
};

let screen = 'menu';
let activeOverlay = null;
let overlayOpenedAt = 0;
let roomCode = null;
let netInfo = null;
let mobileOrigin = null;
let phoneStatus = null;
let lastHandsAt = 0;
let lastPreviewAt = 0;
let usingPhone = false;
let mouseDown = false;
let lastMouseAt = 0;
let lastPadNav = 0;
let padPrev = {};
let gameOverAt = 0;
let swipeRestartArmed = false;
let hintState = '';

const calib = {
  active: false,
  bounds: null,
  locked: false,
  sliced: 0,
  enteredAt: 0,
};

// ---------------------------------------------------------------------------
// Audio unlock
// ---------------------------------------------------------------------------

let audioUnlocked = false;
async function ensureAudio() {
  if (audioUnlocked) {
    if (audio.ctx?.state === 'suspended') audio.ctx.resume().catch(() => {});
    return;
  }
  const ok = await audio.unlock();
  audioUnlocked = ok;
  applyAudioSettings();
  if (ok) {
    audio.startMusic();
    audio.playClick();
  }
}

function applyAudioSettings() {
  audio.musicOn = settings.music;
  audio.setMusicVolume(settings.music ? settings.musicVolume : 0);
  audio.setSfxVolume(settings.sfx ? settings.sfxVolume : 0);
}

// ---------------------------------------------------------------------------
// Solo camera (this device acts as both TV and controller)
// ---------------------------------------------------------------------------

async function startSoloCamera() {
  if (soloTracker) return;
  soloVideo = document.createElement('video');
  soloVideo.playsInline = true;
  soloVideo.muted = true;
  soloVideo.autoplay = true;
  soloVideo.style.cssText = 'position:fixed;right:1.2rem;bottom:1.2rem;width:14rem;aspect-ratio:4/3;border-radius:0.8rem;border:1px solid rgba(255,255,255,0.18);z-index:36;object-fit:cover;transform:scaleX(-1);background:#000;';
  document.body.appendChild(soloVideo);

  let HandTracker;
  try {
    ({ HandTracker } = await import('../shared/tracker.js'));
  } catch (e) {
    toast('Camera module failed to load.', 4000);
    stopSoloCamera();
    return;
  }

  soloTracker = new HandTracker({
    video: soloVideo,
    onFrame: (frame) => {
      game.pointers.ingestHands({
        hands: frame.hands.map((h) => ({
          hand: h.hand, score: h.score, palm: h.palm, tip: h.tip,
          span: h.span, speed: h.speed, pts: h.pts,
        })),
        ts: frame.ts, fps: frame.fps,
      }, performance.now());
      lastHandsAt = performance.now();
      usingPhone = false;
    },
    onStatus: (s) => {
      if (s.error) toast(`Camera: ${s.error}`, 4000);
    },
  });

  try {
    await soloTracker.openCamera('user');
    await soloTracker.initModel();
    soloTracker.start();
    toast('Camera on this device enabled.', 2600);
  } catch (err) {
    toast(`Camera unavailable: ${err?.message || err}`, 4000);
    stopSoloCamera();
  }
}

function stopSoloCamera() {
  soloTracker?.stop();
  soloTracker?.stopStream();
  soloTracker = null;
  if (soloVideo) { soloVideo.remove(); soloVideo = null; }
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function setScreen(name) {
  screen = name;
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('active', key === name);
  }
  document.body.dataset.screen = name;
  closeOverlay();
  if (screens[name]) ui.setScope(screens[name]);
  else ui.setScope(null);
  if (name === 'calib') {
    calib.active = true;
    calib.enteredAt = performance.now();
  } else {
    calib.active = false;
  }
  if (name === 'hub') renderGameGrid();
  if (name !== 'playing' && name !== 'gameover') {
    $('pip').classList.remove('show');
  }
  syncPreviewState();
  sendState();
}

function openOverlay(name) {
  const el = $(`overlay-${name}`);
  if (!el) return;
  for (const o of document.querySelectorAll('.overlay')) o.classList.remove('open');
  el.classList.add('open');
  activeOverlay = name;
  overlayOpenedAt = performance.now();
  ui.setScope(el);
  syncPreviewState();
}

function closeOverlay() {
  if (!activeOverlay) {
    for (const o of document.querySelectorAll('.overlay')) o.classList.remove('open');
    return;
  }
  $(`overlay-${activeOverlay}`).classList.remove('open');
  activeOverlay = null;
  ui.setScope(screens[screen] || null);
  syncPreviewState();
}

function toast(text, ms = 2600) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), ms);
}

function showHint(text) {
  if (hintState === text) return;
  hintState = text;
  const el = $('hint');
  if (!text) {
    el.classList.remove('show');
    return;
  }
  $('hint-text').textContent = text;
  el.classList.add('show');
}

let countdownTimer = 0;
function showCountdown(text, ms = 1100) {
  const el = $('countdown');
  if (!el) return;
  el.firstElementChild.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(countdownTimer);
  countdownTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------------------------------------------------------------------------
// Menu / flow actions
// ---------------------------------------------------------------------------

async function requestFullscreen() {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch {}
}

function toggleFullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
  } catch {}
}

function goMenu() {
  closeOverlay();
  setScreen('menu');
  game.enterAttract();
  game.setGame('fruitninja');
  audio.duck(false);
  audio.setIntensity(0);
  if (audioUnlocked) audio.startMusic();
  updateMenuStatus();
  renderGameGrid();
}

function goHub() {
  closeOverlay();
  if (!selectedGameId) selectedGameId = 'fruitninja';
  game.setGame(selectedGameId);
  game.enterAttract();
  setScreen('hub');
  audio.duck(false);
  audio.setIntensity(0);
  if (audioUnlocked) audio.startMusic();
  updateHubStatus();
  renderGameGrid();
  currentBest = bestFor(selectedGameId);
  updateHudBest();
}

function onPlay() {
  ensureAudio();
  requestFullscreen();
  if (relay.paired || soloCamera) {
    goHub();
  } else {
    setScreen('pair');
    renderPairing();
    if (!relay || relay.state === 'closed' || relay.state === 'error') relay.connect();
  }
}

function onPracticeWithMouse() {
  ensureAudio();
  setScreen('calib');
  startCalibration(true);
}

function enterCalibration() {
  game.setGame('fruitninja');
  setScreen('calib');
  startCalibration(false);
}

function onSelectGame(id) {
  ensureAudio();
  requestFullscreen();
  selectedGameId = id;
  store.set('selectedGame', id);
  game.setGame(id);
  if (id === 'fruitninja' && relay.paired && !settings.calibrated) {
    enterCalibration();
  } else {
    startGame();
  }
}
function startCalibration(mouseMode) {
  calib.active = true;
  calib.bounds = null;
  calib.locked = false;
  calib.sliced = 0;
  calib.enteredAt = performance.now();
  calib.mouseMode = mouseMode;
  game.startPractice();
  if (!mouseMode) requestPreview(true);
  $('calib-coverage').textContent = '0%';
  $('zone-tag').textContent = mouseMode
    ? 'MOUSE MODE · DRAG TO SLICE'
    : 'MOVE BOTH HANDS AROUND THE FRAME';
  $('calib-fps').textContent = phoneStatus?.fps ? String(phoneStatus.fps) : '--';
  $('calib-latency').textContent = relay.rtt != null ? `${relay.rtt} MS` : '--';
  $('cam-hands').textContent = '0 HANDS';
  if (mouseMode) toast('Mouse mode: hold the left button and drag to slice.');
}

function applyCalibration() {
  if (!calib.bounds) return;
  const b = calib.bounds;
  const padX = Math.max(0.035, (b.maxX - b.minX) * 0.06);
  const padY = Math.max(0.03, (b.maxY - b.minY) * 0.06);
  const ranges = {
    x0: clamp(b.minX - padX, 0, 0.55),
    x1: clamp(b.maxX + padX, 0.45, 1),
    y0: clamp(b.minY - padY, 0, 0.55),
    y1: clamp(b.maxY + padY, 0.45, 1),
  };
  settings.calibrated = ranges;
  game.pointers.setRanges(ranges);
  persistSettings();
  calib.locked = true;
  $('zone-tag').textContent = 'AREA LOCKED · YOU ARE READY';
  $('calib-coverage').textContent = '100%';
  audio.playCombo(4);
}

function startGame() {
  closeOverlay();
  setScreen('playing');
  calib.active = false;
  game.startGame();
  audio.duck(false);
  if (audioUnlocked) audio.startMusic();
  audio.setIntensity(0);
  showCountdown('SLICE!', 1200);
  showHint('');
  updateHudBest();
  syncPreviewState();
  sendState();
}

function pauseGame() {
  if (!game.isPlaying || game.paused) return;
  game.pause();
  openOverlay('pause');
  sendState();
}

function resumeGame() {
  if (!game.isPlaying) return;
  closeOverlay();
  game.resume();
  sendState();
}

function quitToHub() {
  closeOverlay();
  game.quit();
  goHub();
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

function persistSettings() {
  store.set('settings', settings);
}

function syncSettingsUi() {
  const setSwitch = (id, on) => {
    const el = $(id);
    if (el) el.setAttribute('aria-checked', String(Boolean(on)));
  };
  setSwitch('set-music', settings.music);
  setSwitch('set-sfx', settings.sfx);
  setSwitch('set-mirror', settings.mirror);
  setSwitch('set-preview', settings.preview);
  setSwitch('set-reduce', settings.reduceFx);
  setSwitch('set-solo', soloCamera);

  $('set-vol-music').value = String(Math.round(settings.musicVolume * 100));
  $('vol-music-val').textContent = `${Math.round(settings.musicVolume * 100)}%`;
  $('set-vol-sfx').value = String(Math.round(settings.sfxVolume * 100));
  $('vol-sfx-val').textContent = `${Math.round(settings.sfxVolume * 100)}%`;
  $('set-sens').value = String(Math.round(settings.sensitivity * 100));
  $('sens-val').textContent = `${settings.sensitivity.toFixed(1)}×`;
}

function applySettings() {
  game.pointers.setSensitivity(settings.sensitivity);
  game.pointers.mirror = settings.mirror;
  applyAudioSettings();
  syncSettingsUi();
  persistSettings();
  updateMenuStatus();
}

function toggle(key) {
  settings[key] = !settings[key];
  applySettings();
  if (key === 'music' && settings.music && audioUnlocked) audio.startMusic();
}

// ---------------------------------------------------------------------------
// High scores / game events
// ---------------------------------------------------------------------------

function updateHudBest() {
  const best = game.currentId ? bestFor(game.currentId) : bestScore;
  $('hud-best').textContent = formatScore(Math.max(best, game.state?.score || 0));
  $('menu-best').textContent = formatScore(bestScore);
}

function onGameEvent(name, data) {
  switch (name) {
    case 'hud':
      if (screen === 'playing') renderHud(data);
      break;
    case 'slice':
      bumpScore();
      if (data.combo >= 3) sendFx('combo');
      break;
    case 'practice-slice':
      calib.sliced++;
      if (calib.active && calib.locked) {
        $('zone-tag').textContent = `NICE SLICE ×${calib.sliced} · START WHEN READY`;
      }
      break;
    case 'bomb':
      sendFx('bomb');
      break;
    case 'miss':
      flashLives(data.lives);
      break;
    case 'gameover':
      showGameOver(data);
      break;
    case 'paused':
    case 'resumed':
    case 'quit':
      sendState();
      break;
    default:
      break;
  }
}

function renderHud(state) {
  $('hud-score').textContent = formatScore(state.score);
  $('hud-best').textContent = formatScore(Math.max(bestScore, state.score));
  const livesEl = $('hud-lives');
  if (livesEl.children.length !== 3) {
    livesEl.innerHTML = '<i><span>✕</span></i>'.repeat(3);
  }
  [...livesEl.children].forEach((el, i) => {
    el.classList.toggle('lost', i >= state.lives);
  });
  const comboEl = $('hud-combo');
  if (state.combo >= 2 && state.comboTimer > 0) {
    comboEl.classList.add('on');
    $('hud-combo-n').textContent = `×${state.combo}`;
    const window = state.comboWindow || 0.55;
    $('hud-combo-bar').style.width = `${clamp(state.comboTimer / window, 0, 1) * 100}%`;
  } else {
    comboEl.classList.remove('on');
  }
}

function bumpScore() {
  const el = $('hud-score');
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

function flashLives(lives) {
  const el = $('hud-lives');
  [...el.children].forEach((node, i) => node.classList.toggle('lost', i >= lives));
  audio.playStrike();
}

function showGameOver(payload) {
  gameOverAt = performance.now();
  swipeRestartArmed = false;
  const id = game.currentId || selectedGameId || 'fruitninja';
  const prevBest = bestFor(id);
  const isRecord = payload.score > prevBest;
  if (isRecord) setBestFor(id, payload.score);
  if (payload.maxCombo > bestCombo) {
    bestCombo = payload.maxCombo;
    store.set('bestCombo', bestCombo);
  }
  currentBest = bestFor(id);
  updateHudBest();

  $('over-score').textContent = formatScore(payload.score);
  $('over-best').textContent = formatScore(currentBest);
  $('over-fruit').textContent = String(payload.sliced ?? 0);
  $('over-combo').textContent = `×${payload.maxCombo || 0}`;
  $('over-time').textContent = `${Math.round(payload.time)}s`;
  $('over-reason').textContent = payload.reason === 'bomb' ? 'BOMB!'
    : payload.reason === 'win' ? 'YOU WIN!'
    : payload.reason === 'loss' ? 'YOU LOSE'
    : payload.reason === 'time' ? 'TIME UP'
    : payload.reason === 'wickets' || payload.reason === 'overs' ? 'INNINGS OVER'
    : 'GAME OVER';
  const gameMeta = GAME_LIST.find((g) => g.id === id);
  $('over-title').textContent = payload.reason === 'bomb' ? 'Boom. Game over.'
    : payload.reason === 'win' ? 'Victory!'
    : payload.reason === 'loss' ? 'Defeat.'
    : payload.reason === 'time' ? `${gameMeta?.title || 'Game'} over!`
    : 'Nice try!';
  $('over-note').textContent = 'Swipe across the screen — or pick an option.';
  $('record-badge').classList.toggle('show', isRecord);

  setScreen('gameover');
  openOverlay('over');
  audio.duck(true);
  audio.playGameOver();
  if (isRecord) {
    setTimeout(() => {
      if (activeOverlay === 'over') audio.playRecord();
    }, 1100);
  }
  sendState();
}

function restartGame() {
  closeOverlay();
  startGame();
}

// ---------------------------------------------------------------------------
// Game action dispatcher (buttons, keyboard, hand dwell)
// ---------------------------------------------------------------------------

function handleAction(action, el) {
  switch (action) {
    case 'play':
      onPlay();
      break;
    case 'howto':
      openOverlay('howto');
      break;
    case 'settings':
      openOverlay('settings');
      syncSettingsUi();
      $('settings-net').textContent = describeRelay();
      break;
    case 'settings-from-howto':
      openOverlay('settings');
      syncSettingsUi();
      break;
    case 'close':
      closeOverlay();
      break;
    case 'back':
      goMenu();
      break;
    case 'back-home':
      goMenu();
      break;
    case 'practice':
      onPracticeWithMouse();
      break;
    case 'recalib':
      calib.bounds = null;
      calib.locked = false;
      $('calib-coverage').textContent = '0%';
      $('zone-tag').textContent = 'RESET · MOVE YOUR HANDS AGAIN';
      game.pointers.setRanges(DEFAULT_RANGES);
      break;
    case 'skipcalib':
      calib.locked = true;
      game.pointers.setRanges(settings.calibrated || DEFAULT_RANGES);
      startGame();
      break;
    case 'startgame':
      if (calib.bounds && !calib.locked) applyCalibration();
      startGame();
      break;
    case 'pause':
      pauseGame();
      break;
    case 'resume':
      resumeGame();
      break;
    case 'restart':
      restartGame();
      break;
    case 'quit':
      quitToHub();
      break;
    case 'launch-game': {
      const id = el?.dataset?.game || selectedGameId;
      onSelectGame(id);
      break;
    }
    case 'toggle-music':
      toggle('music');
      break;
    case 'toggle-sfx':
      toggle('sfx');
      break;
    case 'toggle-mirror':
      toggle('mirror');
      break;
    case 'toggle-preview':
      toggle('preview');
      syncPreviewState();
      break;
    case 'toggle-reduce':
      toggle('reduceFx');
      game.effects.maxParticles = settings.reduceFx ? 380 : 900;
      break;
    case 'toggle-solo':
      soloCamera = !soloCamera;
      store.set('soloCamera', soloCamera);
      syncSettingsUi();
      if (soloCamera) startSoloCamera(); else stopSoloCamera();
      toast(soloCamera ? 'Camera on this device enabled.' : 'Camera on this device disabled.');
      break;
    case 'recalibrate':
      closeOverlay();
      if (relay.paired) enterCalibration();
      else {
        setScreen('pair');
        renderPairing();
      }
      break;
    case 'fullscreen':
      toggleFullscreen();
      break;
    case 'reset-scores':
      bestScore = 0;
      bestCombo = 0;
      store.set('best', 0);
      store.set('bestCombo', 0);
      updateHudBest();
      toast('High scores cleared.');
      break;
    default:
      break;
  }
  if (el && !el.dataset.action?.startsWith('toggle')) audio.playClick();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  ensureAudio();
  handleAction(el.dataset.action, el);
});

document.addEventListener('pointerdown', () => ensureAudio(), { once: true });
document.addEventListener('keydown', () => ensureAudio(), { once: true });

// ---------------------------------------------------------------------------
// Keyboard + gamepad
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const key = e.key;

  if (key === 'Escape') {
    e.preventDefault();
    if (activeOverlay === 'pause') resumeGame();
    else if (activeOverlay) closeOverlay();
    else if (screen === 'playing') pauseGame();
    else if (screen === 'pair' || screen === 'calib') goMenu();
    return;
  }
  if (key === 'm' || key === 'M') {
    settings.music = !settings.music;
    applySettings();
    toast(settings.music ? 'Music on' : 'Music muted');
    return;
  }
  if (key === 'f' || key === 'F') {
    toggleFullscreen();
    return;
  }

  if (!activeOverlay && screen === 'playing') return;

  const navKeys = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right',
  };
  if (navKeys[key]) {
    e.preventDefault();
    const dir = navKeys[key];
    const focused = ui.focused;
    if (focused instanceof HTMLInputElement && focused.type === 'range' && (dir === 'left' || dir === 'right')) {
      ui.adjust(dir === 'right' ? 5 : -5);
    } else {
      ui.move(dir);
    }
    return;
  }
  if (key === 'Enter' || key === ' ') {
    e.preventDefault();
    ui.activate();
    return;
  }
  if (key === 'Tab') {
    // TV remotes often send Tab for "next"; map it to the same spatial nav.
    e.preventDefault();
    ui.move(e.shiftKey ? 'left' : 'right');
  }
});

function pollPadNav(gp, now) {
  if (!gp) return;
  const pressed = (i) => Boolean(gp.buttons[i]?.pressed);
  const ax = gp.axes[0] || 0;
  const ay = gp.axes[1] || 0;
  const state = {
    up: pressed(12) || ay < -0.55,
    down: pressed(13) || ay > 0.55,
    left: pressed(14) || ax < -0.55,
    right: pressed(15) || ax > 0.55,
    ok: pressed(0) || pressed(9),
    back: pressed(1),
  };
  if (now - lastPadNav < 190) {
    padPrev = state;
    return;
  }
  for (const dir of ['up', 'down', 'left', 'right']) {
    if (state[dir] && !padPrev[dir]) {
      lastPadNav = now;
      if (!activeOverlay && screen === 'playing') break;
      ensureAudio();
      ui.move(dir);
      break;
    }
  }
  if (state.ok && !padPrev.ok) {
    lastPadNav = now;
    ensureAudio();
    if (activeOverlay || screen !== 'playing') ui.activate();
  }
  if (state.back && !padPrev.back) {
    lastPadNav = now;
    if (activeOverlay === 'pause') resumeGame();
    else if (activeOverlay) closeOverlay();
    else if (screen === 'playing') pauseGame();
  }
  padPrev = state;
}

// ---------------------------------------------------------------------------
// Mouse / touch slicing
// ---------------------------------------------------------------------------

window.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  lastMouseAt = performance.now();
  mouseDown = e.buttons > 0;
  game.pointers.setMouse(e.clientX, e.clientY, game.view, mouseDown);
  document.body.style.cursor = '';
});
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') return;
  mouseDown = true;
  lastMouseAt = performance.now();
  game.pointers.setMouse(e.clientX, e.clientY, game.view, true);
});
window.addEventListener('pointerup', () => {
  mouseDown = false;
  game.pointers.mouse.down = false;
  game.pointers.mouse.sliceArmed = false;
});
window.addEventListener('blur', () => {
  mouseDown = false;
  game.pointers.mouse.down = false;
  if (screen === 'playing' && !game.paused) pauseGame();
});

// ---------------------------------------------------------------------------
// Pairing + net
// ---------------------------------------------------------------------------

function describeRelay() {
  if (!relay) return 'Relay: not started';
  if (relay.paired) return `Local relay connected · ${roomCode || '—'} · ${relay.rtt ?? '–'} ms`;
  if (relay.state === 'ready' || relay.state === 'waiting') return `Waiting for phone · code ${roomCode || '—'}`;
  if (relay.state === 'reconnecting') return 'Relay reconnecting…';
  if (relay.state === 'error') return 'Relay error — using mouse controls';
  return 'Relay offline';
}

function updateHubStatus() {
  const dot = $('hub-dot');
  const text = $('hub-status-text');
  if (!dot || !text) return;
  if (relay.paired) {
    dot.classList.add('live');
    text.textContent = `PHONE CONNECTED${relay.rtt != null ? ` · ${relay.rtt} MS` : ''}`;
  } else {
    dot.classList.remove('live');
    text.textContent = relay.state === 'error' || relay.state === 'closed' ? 'NO PHONE · MOUSE OK' : 'NO PHONE CONNECTED';
  }
}

function renderGameGrid() {
  const grid = $('game-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const g of GAME_LIST) {
    const card = document.createElement('button');
    card.className = 'game-card';
    card.dataset.action = 'launch-game';
    card.dataset.game = g.id;
    card.style.setProperty('--card-glow', hexToRgba(g.color, 0.22));
    card.innerHTML = `
      <div class="game-emoji" aria-hidden="true">${g.emoji}</div>
      <div class="game-title">${g.title}</div>
      <div class="game-sub">${g.subtitle}</div>
      <div class="game-meta"><span>${g.players} PLAYER${g.players === '1' ? '' : 'S'}</span><b>BEST ${formatScore(bestFor(g.id))}</b></div>
      <span class="game-play">PLAY</span>
    `;
    grid.appendChild(card);
  }
  ui.refresh();
}

function hexToRgba(hex, a) {
  const m = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  if (!m) return `rgba(255,255,255,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}
function updateMenuStatus() {
  const dot = $('menu-dot');
  const text = $('menu-status-text');
  if (!dot || !text) return;
  if (soloCamera || relay.paired) {
    dot.classList.add('live');
    text.textContent = soloCamera
      ? 'CAMERA ON THIS DEVICE'
      : `PHONE CONNECTED${relay.rtt != null ? ` · ${relay.rtt} MS` : ''}`;
  } else {
    dot.classList.remove('live');
    text.textContent =
      relay.state === 'error' || relay.state === 'closed'
        ? 'NO PHONE · MOUSE + KEYBOARD ONLY'
        : 'NO PHONE CONNECTED';
  }
}

function renderPairing() {
  if (!roomCode) {
    $('pair-status-text').textContent = 'Setting up a room…';
    $('room-code').textContent = '····';
    $('qr').innerHTML = '';
    return;
  }
  const statusText = $('pair-status-text');
  const status = $('pair-status');
  status.classList.remove('connected', 'error');
  if (relay.paired) {
    status.classList.add('connected');
    statusText.textContent = 'Phone connected! Starting calibration…';
  } else if (relay.state === 'error') {
    status.classList.add('error');
    statusText.textContent = 'Relay unreachable — check the server';
  } else if (relay.state === 'reconnecting') {
    statusText.textContent = 'Reconnecting to the relay…';
  } else {
    statusText.textContent = 'Waiting for your phone…';
  }

  $('room-code').textContent = roomCode;
  const base = mobileOrigin || location.origin;
  const url = `${base.replace(/\/$/, '')}/mobile.html?c=${roomCode}`;
  $('pair-url').textContent = url.replace(/^https?:\/\//, '');
  renderQr(url, base);
}

function renderQr(url, base) {
  const box = $('qr');
  if (!window.qrcode) {
    box.textContent = url;
    return;
  }
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
    const svg = box.querySelector('svg');
    if (svg) {
      svg.setAttribute('shape-rendering', 'crispEdges');
      svg.style.width = '100%';
      svg.style.height = '100%';
    }
  } catch (err) {
    box.textContent = url;
  }
  if (base.startsWith('http://') && !/localhost|127\.0\.0\.1/.test(base)) {
    $('pair-url').textContent = `${url.replace(/^https?:\/\//, '')} · camera needs HTTPS (see README)`;
  }
}

async function loadNetInfo() {
  try {
    const res = await fetch('/api/net', { cache: 'no-store' });
    if (res.ok) netInfo = await res.json();
  } catch {
    netInfo = null;
  }
  mobileOrigin = netInfo?.mobileOrigin || location.origin;
  if (roomCode) renderPairing();
}

relay.on('welcome', (msg) => {
  roomCode = msg.code;
  try {
    sessionStorage.setItem('fn.room', roomCode);
  } catch {}
  usingPhone = Boolean(msg.peer);
  if (screen === 'pair') renderPairing();
  updateMenuStatus();
  sendState();
});

relay.on('peer', ({ present }) => {
  usingPhone = present;
  if (present) {
    toast('Phone connected. Stand 2–3 metres back.', 3200);
    audio.playCombo(3);
    if (screen === 'pair') {
      renderPairing();
      setTimeout(() => {
        if (relay.paired && screen === 'pair') goHub();
      }, 1000);
    }
  } else {
    sendFx('bye');
    if (screen === 'playing' && !game.paused) {
      pauseGame();
      toast('Phone disconnected — reconnect to keep playing with motion.', 4000);
    } else if (screen === 'pair') {
      renderPairing();
    }
  }
  updateMenuStatus();
  updateHubStatus();
});

relay.on('status', ({ state, rtt }) => {
  updateMenuStatus();
  updateHubStatus();
  if (screen === 'pair') renderPairing();
  if (activeOverlay === 'settings') $('settings-net').textContent = describeRelay();
  if (screen === 'calib') {
    $('calib-latency').textContent = rtt != null ? `${rtt} MS` : '--';
  }
  if (state === 'error' && screen === 'pair') {
    toast('Cannot reach the relay. Is the game server running?', 4200);
  }
});

relay.on('fatal', (msg) => {
  toast(msg.message || 'Relay error', 4000);
});

relay.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case MSG.HANDS:
      if (isValidHands(msg)) {
        lastHandsAt = performance.now();
        usingPhone = true;
        game.pointers.ingestHands(msg, performance.now());
        if (msg.fps) {
          phoneStatus = { ...(phoneStatus || {}), fps: msg.fps };
          if (screen === 'calib') $('calib-fps').textContent = String(msg.fps);
        }
        if (screen === 'calib') updateCalibrationFromHands(msg);
        if (screen === 'calib') $('cam-hands').textContent = `${msg.hands.length} HAND${msg.hands.length === 1 ? '' : 'S'}`;
      }
      break;
    case MSG.STATUS: {
      phoneStatus = { ...(phoneStatus || {}), ...msg };
      if (msg.previewRequested === false && settings.preview) requestPreview(true);
      if (screen === 'calib') {
        if (msg.fps) $('calib-fps').textContent = String(msg.fps);
        $('cam-hands').textContent = `${msg.hands || 0} HAND${msg.hands === 1 ? '' : 'S'}`;
      }
      if (msg.error) toast(`Phone camera: ${msg.error}`, 5000);
      sendState();
      break;
    }
    case MSG.PREVIEW: {
      if (!msg.jpeg) break;
      lastPreviewAt = performance.now();
      const src = `data:image/jpeg;base64,${msg.jpeg}`;
      const cam = $('cam-preview');
      const pip = $('pip-img');
      if (screen === 'calib') {
        cam.src = src;
        $('cam-card').classList.add('has-preview', 'visible');
      }
      if (screen === 'playing' && settings.preview) {
        pip.src = src;
        $('pip').classList.add('show');
      }
      break;
    }
    case MSG.CALIB: {
      if (msg.ranges) {
        settings.calibrated = msg.ranges;
        game.pointers.setRanges(msg.ranges);
        persistSettings();
        toast('Calibration received from phone.');
      }
      break;
    }
    case MSG.CMD:
      handlePhoneCommand(msg.cmd);
      break;
    case MSG.HELLO_MOBILE:
      phoneStatus = { ...(phoneStatus || {}), info: msg.info };
      break;
    case MSG.FX:
      break;
    default:
      break;
  }
});

function handlePhoneCommand(cmd) {
  switch (cmd) {
    case CMD.PAUSE:
      pauseGame();
      break;
    case CMD.RESUME:
      resumeGame();
      break;
    case CMD.RESTART:
      restartGame();
      break;
    case CMD.QUIT:
      quitToMenu();
      break;
    case CMD.CALIBRATE:
      enterCalibration();
      break;
    case CMD.START:
      if (screen === 'menu') onPlay();
      else if (screen === 'calib') startGame();
      break;
    case CMD.SELECT:
      ui.activate();
      break;
    default:
      break;
  }
}

function updateCalibrationFromHands(msg) {
  if (!calib.active || calib.locked) return;
  for (const h of msg.hands) {
    const [x, y] = h.palm;
    if (!calib.bounds) {
      calib.bounds = { minX: x, maxX: x, minY: y, maxY: y };
    } else {
      const b = calib.bounds;
      b.minX = Math.min(b.minX, x);
      b.maxX = Math.max(b.maxX, x);
      b.minY = Math.min(b.minY, y);
      b.maxY = Math.max(b.maxY, y);
    }
  }
  if (!calib.bounds) return;
  const b = calib.bounds;
  const spanX = b.maxX - b.minX;
  const spanY = b.maxY - b.minY;
  // Also apply a live, forgiving mapping while they get into position.
  if (!calib.locked) {
    game.pointers.setRanges({
      x0: clamp(b.minX - 0.05, 0, 0.6),
      x1: clamp(b.maxX + 0.05, 0.4, 1),
      y0: clamp(b.minY - 0.05, 0, 0.6),
      y1: clamp(b.maxY + 0.05, 0.4, 1),
    });
  }
  const coverage = Math.round(clamp(Math.min(spanX / 0.46, spanY / 0.38) * 100, 0, 100));
  $('calib-coverage').textContent = `${coverage}%`;
  if (coverage >= 100) {
    $('zone-tag').textContent = 'AREA LOCKED · TRY A SLICE';
    applyCalibration();
  }
}

function sendState() {
  if (!relay.paired) return;
  relay.send({
    t: MSG.STATE,
    screen,
    overlay: activeOverlay,
    game: game.currentId,
    score: game.state.score,
    best: bestScore,
    lives: game.state.lives,
    combo: game.state.combo,
    paused: game.paused,
    muted: !settings.music && !settings.sfx,
    phone: Boolean(phoneStatus?.camera),
  });
}

let stateClock = 0;
function pulseState() {
  const now = performance.now();
  if (now - stateClock < 450) return;
  stateClock = now;
  sendState();
}

function sendFx(kind) {
  if (relay.paired) relay.send({ t: MSG.FX, kind });
}

function requestPreview(on) {
  if (relay.paired) relay.send({ t: MSG.WANT_PREVIEW, on });
}

function syncPreviewState() {
  const want = Boolean(
    settings.preview &&
    relay.paired &&
    (screen === 'calib' || screen === 'playing' || activeOverlay === 'pause'),
  );
  requestPreview(want);
  if (!want) {
    $('pip').classList.remove('show');
    $('cam-card').classList.remove('visible');
  }
}

// ---------------------------------------------------------------------------
// Pointer layer: hand cursor, dwell rings, calibration frame
// ---------------------------------------------------------------------------

let pcssW = 0;
let pcssH = 0;
function resizePointerCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  pcssW = window.innerWidth;
  pcssH = window.innerHeight;
  pointerCanvas.width = Math.round(pcssW * dpr);
  pointerCanvas.height = Math.round(pcssH * dpr);
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function worldToClient(p) {
  return {
    x: game.view.offsetX + p.x * game.view.scale,
    y: game.view.offsetY + p.y * game.view.scale,
  };
}

function drawFrame(now) {
  if (!calib.active) return;
  const w = pcssW;
  const h = pcssH;
  const insetX = Math.max(20, w * 0.09);
  const insetY = Math.max(28, h * 0.215);
  const x = insetX;
  const y = insetY;
  const bw = w - insetX * 2;
  const bh = h - insetY * 2 - h * 0.05;
  const pulse = 0.45 + Math.sin(now / 420) * 0.18;
  const locked = calib.locked;

  pctx.save();
  pctx.lineWidth = 2.5;
  pctx.setLineDash([14, 18]);
  pctx.strokeStyle = locked ? `rgba(118,224,138,${pulse})` : `rgba(142,240,255,${pulse})`;
  pctx.beginPath();
  pctx.roundRect(x, y, bw, bh, 26);
  pctx.stroke();
  pctx.setLineDash([]);

  // corner brackets
  const corner = 42;
  pctx.lineWidth = 5;
  pctx.lineCap = 'round';
  pctx.strokeStyle = locked ? 'rgba(118,224,138,0.95)' : 'rgba(142,240,255,0.9)';
  const corners = [
    [x, y, 1, 1], [x + bw, y, -1, 1], [x, y + bh, 1, -1], [x + bw, y + bh, -1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    pctx.beginPath();
    pctx.moveTo(cx + sx * corner, cy);
    pctx.lineTo(cx, cy);
    pctx.lineTo(cx, cy + sy * corner);
    pctx.stroke();
  }

  // Reach guide dots so the player knows how far to stretch.
  pctx.fillStyle = 'rgba(255,246,233,0.12)';
  for (const [dx, dy] of [[0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7]]) {
    pctx.beginPath();
    pctx.arc(x + bw * dx, y + bh * dy, 4, 0, Math.PI * 2);
    pctx.fill();
  }
  pctx.restore();
}

function drawHandCursors(now) {
  const showUi = Boolean(activeOverlay) || screen !== 'playing';
  if (!showUi) return;
  const blades = game.pointers.blades();
  for (const b of blades) {
    if (b.kind !== 'hand' || b.opacity < 0.05) continue;
    const pos = worldToClient(b);
    if (pos.x < -50 || pos.y < -50 || pos.x > pcssW + 50 || pos.y > pcssH + 50) continue;
    let dwell = { progress: 0, hovering: null };
    if (b.kind === 'hand' && b.speed < 900) {
      dwell = ui.dwellAt(b, pos.x, pos.y, now);
    }
    // cursor body
    pctx.save();
    pctx.globalAlpha = b.opacity;
    const grad = pctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 26);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.35, 'rgba(180,244,255,0.55)');
    grad.addColorStop(1, 'rgba(140,220,255,0)');
    pctx.fillStyle = grad;
    pctx.beginPath();
    pctx.arc(pos.x, pos.y, 26, 0, Math.PI * 2);
    pctx.fill();
    pctx.fillStyle = '#ffffff';
    pctx.beginPath();
    pctx.arc(pos.x, pos.y, 5.5, 0, Math.PI * 2);
    pctx.fill();

    // dwell ring
    const r = 30;
    pctx.lineWidth = 4;
    pctx.strokeStyle = dwell.hovering ? 'rgba(255,215,106,0.9)' : 'rgba(255,255,255,0.35)';
    pctx.beginPath();
    pctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    pctx.stroke();
    if (dwell.progress > 0) {
      pctx.strokeStyle = '#ffd76a';
      pctx.lineWidth = 5;
      pctx.lineCap = 'round';
      pctx.beginPath();
      pctx.arc(pos.x, pos.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * dwell.progress);
      pctx.stroke();
    }
    pctx.restore();

    // Swipe-to-restart on the game-over screen.
    if (activeOverlay === 'over' && now - gameOverAt > 1200) {
      if (b.speed > 1700) swipeRestartArmed = true;
      if (swipeRestartArmed && now - gameOverAt > 1400) {
        swipeRestartArmed = false;
        restartGame();
      }
    }
  }
}

function uiLoop(now) {
  requestAnimationFrame(uiLoop);

  // Gamepad: menu navigation + right-stick fallback blade.
  const gp = game.pointers.pollGamepad(now);
  pollPadNav(gp, now);

  // Hide the mouse dot when it has been idle for a while.
  if (performance.now() - lastMouseAt > 2600) {
    game.pointers.mouse.visible = false;
    game.pointers.mouse.active = false;
  }

  pctx.clearRect(0, 0, pcssW, pcssH);
  drawFrame(now);
  drawHandCursors(now);

  // Calibration live numbers.
  if (screen === 'calib' && phoneStatus?.fps) {
    $('calib-fps').textContent = String(phoneStatus.fps);
  }
  if (screen === 'calib') {
    $('calib-latency').textContent = relay.rtt != null ? `${relay.rtt} MS` : '--';
  }

  // "No hands" guidance + auto-pause.
  if (screen === 'playing' && game.isPlaying && !game.paused && (usingPhone || soloCamera)) {
    const idle = performance.now() - lastHandsAt;
    if (idle > 2200 && idle < 9000) {
      showHint('Step back so the phone can see both hands');
    } else if (idle >= 9000) {
      showHint('');
      pauseGame();
      toast('Paused — we lost track of your hands.', 3800);
    } else {
      showHint('');
    }
  } else if (screen === 'calib' && calib.active) {
    if (performance.now() - lastHandsAt > 4000 && !calib.mouseMode) {
      showHint('No hands detected — check the phone is facing you');
    } else {
      showHint('');
    }
  } else {
    showHint('');
  }

  // Hide stale camera previews.
  if (screen === 'calib' && performance.now() - lastPreviewAt > 2600) {
    $('cam-card').classList.remove('has-preview');
  }
  if (screen === 'playing' && performance.now() - lastPreviewAt > 2600) {
    $('pip').classList.remove('show');
  }

  pulseState();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  resizePointerCanvas();
  onResize(document.body, () => {
    game.resize();
    resizePointerCanvas();
  });
  window.addEventListener('resize', () => game.resize());

  applySettings();
  updateHudBest();
  syncSettingsUi();
  updateMenuStatus();
  updateHubStatus();

  if (soloCamera) startSoloCamera();

  $('hud-lives').innerHTML = '<i><span>✕</span></i>'.repeat(3);
  $('calib-latency').textContent = '--';

  relay.connect();
  loadNetInfo();
  setScreen('menu');
  game.enterAttract();
  renderGameGrid();
  requestAnimationFrame(uiLoop);

  // Periodic re-render of the pairing screen (room/RTT changes).
  setInterval(() => {
    if (screen === 'pair') renderPairing();
  }, 2000);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && screen === 'playing' && !game.paused) pauseGame();
  });

  window.addEventListener('beforeunload', () => relay.close());
  window.addEventListener('error', (e) => {
    console.error(e.error || e.message);
  });

  // Debug/QA hooks: `?auto=1` starts mouse mode immediately.
  const params = new URLSearchParams(location.search);
  if (params.get('auto') === '1') {
    setTimeout(() => onPracticeWithMouse(), 600);
  }
  if (params.get('debug') === '1') {
    window.__fn = {
      game,
      relay,
      ui,
      settings,
      audio,
      calib,
      startGame,
      goMenu,
      enterCalibration,
      goHub,
      onPracticeWithMouse,
      get screen() {
        return screen;
      },
      get overlay() {
        return activeOverlay;
      },
    };
  }
}

// Handle settings sliders.
for (const input of document.querySelectorAll('input[type="range"][data-setting]')) {
  input.addEventListener('input', () => {
    const key = input.dataset.setting;
    const value = Number(input.value);
    if (key === 'musicVolume' || key === 'sfxVolume') settings[key] = value / 100;
    else if (key === 'sensitivity') settings.sensitivity = value / 100;
    applySettings();
  });
  input.addEventListener('focus', () => ui.focusEl(input));
}

boot();

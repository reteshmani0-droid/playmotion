/**
 * End-to-end smoke test. No browser needed.
 *
 *   npm run smoke
 *
 * Boots the real server on a spare port, then exercises:
 *   - static routes (TV page, phone page, modules, vendored MediaPipe assets)
 *   - /api/net + /api/health
 *   - room creation, TV + phone pairing
 *   - hands packet relay in both directions, commands, state mirroring
 *   - unknown room handling and graceful shutdown
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT || 8123);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeout = 5000, interval = 60) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await sleep(interval);
  }
  return null;
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const timer = setTimeout(() => reject(new Error('ws connect timeout')), 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Collect parsed messages on a socket + a helper to await one. */
function track(ws) {
  const messages = [];
  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()));
    } catch {}
  });
  return {
    messages,
    async next(predicate, timeout = 4000) {
      const found = await waitFor(() => messages.find(predicate), timeout, 30);
      if (!found) throw new Error('timed out waiting for message');
      return found;
    },
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    drain() {
      messages.length = 0;
    },
  };
}

function closeSocket(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === 3) return resolve();
    ws.once('close', resolve);
    try {
      ws.close();
    } catch {
      resolve();
    }
    setTimeout(resolve, 1200).unref?.();
  });
}

// ---------------------------------------------------------------------------
// 0. Syntax check every browser + server module
// ---------------------------------------------------------------------------

function syntaxCheck() {
  const roots = ['public/js', 'server', 'test'];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(full);
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));

  let bad = 0;
  for (const file of files) {
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (res.status !== 0) {
      bad++;
      console.log(`  ✗ syntax: ${path.relative(ROOT, file)}`);
      console.log(String(res.stderr).split('\n').slice(0, 3).join('\n'));
    }
  }
  ok(`syntax check (${files.length} modules)`, bad === 0, `${bad} failed`);
}

// ---------------------------------------------------------------------------
// 1. Server boot
// ---------------------------------------------------------------------------

async function main() {
  console.log('');
  console.log('  FRUIT NINJA TV · smoke test');
  console.log('');

  syntaxCheck();

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NO_HTTPS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => {
    serverLog += d.toString();
  });
  server.stderr.on('data', (d) => {
    serverLog += d.toString();
  });

  try {
    const up = await waitFor(async () => {
      const res = await fetch(`${BASE}/api/health`);
      return res.ok;
    }, 12_000, 150);
    ok('server boots', Boolean(up), serverLog.slice(-400));
    if (!up) throw new Error('server did not start');

    // -----------------------------------------------------------------------
    // 2. HTTP routes
    // -----------------------------------------------------------------------
    console.log('\n  HTTP');
    const tvRes = await fetch(`${BASE}/tv`);
    const tvHtml = await tvRes.text();
    ok('GET /tv serves the TV page', tvRes.ok && tvHtml.includes('FRUIT') && tvHtml.includes('id="stage"'));
    ok('TV page loads the app module', tvHtml.includes('/js/tv/app.js'));
    ok('TV page loads the QR vendor script', tvHtml.includes('/vendor/qrcode.js'));

    const phone = await fetch(`${BASE}/m`);
    const phoneHtml = await phone.text();
    ok('GET /m serves the phone page', phone.ok && phoneHtml.includes('btn-start'));
    ok('phone page loads MediaPipe app', phoneHtml.includes('/js/mobile/main.js'));

    const appJs = await fetch(`${BASE}/js/tv/app.js`);
    ok('GET module content-type is JS', appJs.ok && String(appJs.headers.get('content-type')).includes('javascript'));
    ok('module body is non-empty', (await appJs.text()).length > 1000);

    const wasm = await fetch(`${BASE}/vendor/mediapipe/vision_wasm_internal.wasm`, { method: 'HEAD' });
    ok('vendored wasm served as application/wasm',
      wasm.ok && wasm.headers.get('content-type') === 'application/wasm');
    ok('vendor assets are long-cached', String(wasm.headers.get('cache-control')).includes('immutable'));

    const model = await fetch(`${BASE}/vendor/mediapipe/hand_landmarker.task`, { method: 'HEAD' });
    ok('hand model is present', model.ok && Number(model.headers.get('content-length')) > 1_000_000);

    const qr = await fetch(`${BASE}/vendor/qrcode.js`);
    ok('QR generator is vendored', qr.ok && (await qr.text()).length > 1000);

    const net = await (await fetch(`${BASE}/api/net`)).json();
    ok('GET /api/net reports a mobile origin', Boolean(net.mobileOrigin) && net.mobileOrigin.startsWith('http'));
    ok('GET /api/net reports LAN interfaces', Array.isArray(net.lan));

    const missing = await fetch(`${BASE}/nope`, { redirect: 'manual' });
    ok('unknown route redirects to launcher', missing.status === 302 || missing.status === 200);

    // -----------------------------------------------------------------------
    // 3. Pairing + relay
    // -----------------------------------------------------------------------
    console.log('\n  Relay');
    const tvWs = await openSocket();
    const tv = track(tvWs);
    tv.send({ t: 'hello', role: 'tv', v: 1, code: null });
    const tvWelcome = await tv.next((m) => m.t === 'welcome');
    ok('TV gets a room code', /^[A-Z]{4}$/.test(tvWelcome.code), tvWelcome.code);
    ok('TV starts without a peer', tvWelcome.peer === false);

    const badWs = await openSocket();
    const bad = track(badWs);
    bad.send({ t: 'hello', role: 'mobile', v: 1, code: 'ZZZZ' });
    const badMsg = await bad.next((m) => m.t === 'error');
    ok('unknown room code is rejected', badMsg.code === 'ROOM_NOT_FOUND');
    await closeSocket(badWs);

    const mobileWs = await openSocket();
    const mobile = track(mobileWs);
    mobile.send({ t: 'hello', role: 'mobile', v: 1, code: tvWelcome.code });
    const mobileWelcome = await mobile.next((m) => m.t === 'welcome');
    ok('phone joins the room', mobileWelcome.code === tvWelcome.code);
    ok('phone sees the TV already present', mobileWelcome.peer === true);
    const joined = await tv.next((m) => m.t === 'peer-joined');
    ok('TV is told the phone joined', joined.role === 'mobile');

    // Phone -> TV: tracking packet (shaped exactly like the real one).
    const hands = {
      t: 'hands',
      seq: 0,
      ts: 1234.5,
      fps: 30,
      frame: { w: 640, h: 480 },
      hands: [
        {
          hand: 'Right',
          score: 0.98,
          palm: [0.5, 0.42],
          tip: [0.58, 0.3],
          span: 0.12,
          speed: 1.4,
          pts: Array.from({ length: 42 }, (_, i) => (i % 2 ? 0.3 : 0.5)),
        },
      ],
    };
    mobile.send(hands);
    const relayed = await tv.next((m) => m.t === 'peer' && m.data?.t === 'hands');
    ok('hand tracking reaches the TV', relayed.data.hands[0].palm[0] === 0.5);
    ok('relay keeps the packet opaque', relayed.data.seq === 0 && relayed.data.fps === 30);

    mobile.send({ t: 'cmd', cmd: 'pause' });
    const cmdAtTv = await tv.next((m) => m.t === 'peer' && m.data?.t === 'cmd');
    ok('phone commands reach the TV', cmdAtTv.data.cmd === 'pause');

    // TV -> phone: state + preview requests.
    tv.send({ t: 'state', screen: 'playing', score: 120, lives: 2, paused: false });
    const stateAtPhone = await mobile.next((m) => m.t === 'peer' && m.data?.t === 'state');
    ok('TV state reaches the phone', stateAtPhone.data.score === 120 && stateAtPhone.data.lives === 2);

    tv.send({ t: 'want-preview', on: true });
    const previewReq = await mobile.next((m) => m.t === 'peer' && m.data?.t === 'want-preview');
    ok('TV can request the setup preview', previewReq.data.on === true);

    // Latency probe answered by the relay itself.
    const t0 = Date.now();
    mobile.send({ t: 'ping', ts: t0 });
    const pong = await mobile.next((m) => m.t === 'pong');
    ok('relay answers latency pings', pong.ts === t0);

    // Rate limiting should not break normal 60 Hz traffic.
    for (let i = 0; i < 120; i++) mobile.send({ ...hands, seq: i + 1 });
    const lastHand = await waitFor(() => {
      const found = tv.messages.filter((m) => m.t === 'peer' && m.data?.t === 'hands');
      return found.find((m) => m.data.seq === 120);
    }, 4000, 40);
    ok('relay sustains a burst of 120 frames', Boolean(lastHand));

    // -----------------------------------------------------------------------
    // 4. Disconnect + room cleanup
    // -----------------------------------------------------------------------
    console.log('\n  Presence');
    await closeSocket(mobileWs);
    const left = await tv.next((m) => m.t === 'peer-left');
    ok('TV learns the phone left', left.role === 'mobile');

    const health = await (await fetch(`${BASE}/api/health`)).json();
    ok('health endpoint reports rooms', health.ok === true && typeof health.rooms === 'number');

    await closeSocket(tvWs);
    ok('sockets close cleanly', tvWs.readyState === 3 && mobileWs.readyState === 3);
  } catch (err) {
    failed++;
    failures.push(err.message);
    console.error('\n  ✗', err.stack || err.message);
  } finally {
    try {
      server.kill();
    } catch {}
    await sleep(300);
  }

  console.log('');
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`  failing: ${failures.join(', ')}`);
    console.log('');
    process.exit(1);
  }
  console.log('  All good. Open http://localhost:8080/tv and press PLAY.');
  console.log('');
}

main();

/**
 * FRUIT NINJA TV — local game server.
 *
 * Responsibilities:
 *   1. Serve the TV page (public/tv.html) and phone camera page (public/mobile.html).
 *   2. Relay hand-tracking packets between the paired TV and phone over WebSocket.
 *   3. Provide HTTPS on the LAN so phone browsers allow camera access.
 *
 * Everything is same-origin and dependency-light, so it also runs unchanged on a
 * free PaaS (Render / Fly / Railway) or behind a Cloudflare quick tunnel.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { RoomRegistry } from './rooms.js';
import { createStaticHandler } from './static.js';
import { ensureCertificate } from './tls.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const HTTP_PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const ENABLE_HTTPS = process.env.NO_HTTPS !== '1';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const log = (...args) => console.log('[fruit]', ...args);

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push({ name, address: item.address });
    }
  }
  return out;
}

function isLoopbackHost(host = '') {
  const h = host.split(':')[0].toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function requestOrigin(req, secure) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const scheme = proto === 'https' || secure ? 'https' : 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${HTTP_PORT}`;
  return `${scheme}://${host}`;
}

/**
 * Where the phone should be pointed at. Camera APIs require a secure context,
 * so on plain-HTTP LAN setups we hand out the HTTPS port instead.
 */
function mobileOrigin(req, secure) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const origin = requestOrigin(req, secure);
  if (secure) return origin;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (!isLoopbackHost(host)) {
    const hostname = host.split(':')[0];
    return ENABLE_HTTPS ? `https://${hostname}:${HTTPS_PORT}` : `http://${hostname}:${HTTP_PORT}`;
  }
  const lan = lanAddresses()[0];
  if (!lan) return origin;
  return ENABLE_HTTPS ? `https://${lan.address}:${HTTPS_PORT}` : `http://${lan.address}:${HTTP_PORT}`;
}

// ---------------------------------------------------------------------------
// HTTP(S) app
// ---------------------------------------------------------------------------

const serveStatic = createStaticHandler(PUBLIC_DIR);
const registry = new RoomRegistry(log);

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const secure = Boolean(req.socket.encrypted);

  if (url.pathname === '/api/net') {
    const body = JSON.stringify({
      ok: true,
      secure,
      lan: lanAddresses(),
      httpPort: HTTP_PORT,
      httpsPort: ENABLE_HTTPS ? HTTPS_PORT : null,
      mobileOrigin: mobileOrigin(req, secure),
      serverTime: Date.now(),
      ...registry.stats,
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), ...registry.stats }));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }

  if (await serveStatic(req, res, url.pathname)) return;

  // Friendly fallback: send people back to the launcher.
  res.writeHead(302, { Location: '/' });
  res.end();
}

// ---------------------------------------------------------------------------
// WebSocket relay
// ---------------------------------------------------------------------------

function attachRelay(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 160 * 1024 });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.room = null;
    ws.role = null;
    ws.msgWindow = { start: Date.now(), count: 0 };

    const helloTimer = setTimeout(() => {
      if (!ws.room) {
        send(ws, { t: 'error', code: 'HELLO_TIMEOUT', message: 'Handshake timeout' });
        ws.close(4002, 'hello timeout');
      }
    }, 8000);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      // Cheap abuse guard. Normal traffic is ~60 small packets/s.
      const now = Date.now();
      if (now - ws.msgWindow.start > 1000) ws.msgWindow = { start: now, count: 0 };
      if (++ws.msgWindow.count > 400) {
        ws.close(4008, 'rate limit');
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.t === 'hello') {
        if (ws.room) return;
        clearTimeout(helloTimer);

        if (msg.role === 'tv') {
          // A TV that refreshes the page can reclaim its previous code so the
          // phone that is already scanning/paired stays connected.
          let room = msg.code ? registry.reclaim(String(msg.code).toUpperCase(), ws) : null;
          if (!room) room = registry.createRoom();
          ws.room = room;
          ws.role = 'tv';
          room.tv = ws;
          room.lastSeen = Date.now();
          send(ws, {
            t: 'welcome',
            role: 'tv',
            code: room.code,
            peer: Boolean(room.mobile && room.mobile.readyState === 1),
            serverTime: Date.now(),
          });
          if (room.mobile && room.mobile.readyState === 1) {
            send(room.mobile, { t: 'peer-joined', role: 'tv' });
          }
          log(`TV socket ready for room ${room.code}`);
          return;
        }

        if (msg.role === 'mobile') {
          const room = registry.get(msg.code);
          if (!room) {
            send(ws, { t: 'error', code: 'ROOM_NOT_FOUND', message: 'That code is not on screen' });
            setTimeout(() => ws.close(4004, 'unknown room'), 250);
            return;
          }
          ws.room = room;
          ws.role = 'mobile';
          const hadTv = Boolean(room.tv && room.tv.readyState === 1);
          registry.attach(room.code, 'mobile', ws);
          send(ws, {
            t: 'welcome',
            role: 'mobile',
            code: room.code,
            peer: hadTv,
            serverTime: Date.now(),
          });
          if (hadTv) send(room.tv, { t: 'peer-joined', role: 'mobile' });
          log(`phone joined room ${room.code}`);
          return;
        }

        send(ws, { t: 'error', code: 'BAD_ROLE', message: 'Unknown role' });
        ws.close(4003, 'bad role');
        return;
      }

      if (!ws.room) return;

      if (msg.t === 'bye') {
        registry.destroy(ws.room.code);
        ws.close(4000, 'bye');
        return;
      }

      if (msg.t === 'ping') {
        // App-level ping so the UI can measure round-trip latency.
        send(ws, { t: 'pong', ts: msg.ts, serverTime: Date.now() });
        return;
      }

      const room = ws.room;
      const other = ws.role === 'tv' ? room.mobile : room.tv;
      if (other && other.readyState === 1) send(other, { t: 'peer', data: msg });
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      const room = ws.room;
      if (!room) return;
      registry.detach(room, ws.role, ws);
      const other = ws.role === 'tv' ? room.mobile : room.tv;
      if (other && other.readyState === 1) {
        send(other, { t: 'peer-left', role: ws.role });
      }
      if (ws.role === 'tv') {
        // Keep the code warm for a refresh; destroy it only if the TV stays away.
        registry.orphan(room.code, 120_000);
      }
      log(`${ws.role} left room ${room.code}`);
    });

    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    }
  }, 15_000);
  heartbeat.unref?.();

  return wss;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log('request error', err?.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    });
  });
  attachRelay(httpServer);

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(HTTP_PORT, '0.0.0.0', resolve);
  });
  log(`HTTP  ready on port ${HTTP_PORT}`);

  let httpsPort = null;
  if (ENABLE_HTTPS) {
    try {
      const { key, cert } = await ensureCertificate(path.join(ROOT, '.certs'), lanAddresses());
      const httpsServer = https.createServer({ key, cert }, (req, res) => {
        handleRequest(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Server error');
        });
      });
      attachRelay(httpsServer);
      await new Promise((resolve, reject) => {
        httpsServer.once('error', reject);
        httpsServer.listen(HTTPS_PORT, '0.0.0.0', resolve);
      });
      httpsPort = HTTPS_PORT;
      log(`HTTPS ready on port ${HTTPS_PORT} (self-signed cert in .certs/)`);
    } catch (err) {
      log('HTTPS disabled:', err?.message || err);
    }
  }

  const lan = lanAddresses();
  const primary = lan[0];
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  PLAYMOTION                              │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
  console.log('  TV page (open on your TV / PC):');
  console.log(`    http://localhost:${HTTP_PORT}/tv`);
  if (primary) console.log(`    http://${primary.address}:${HTTP_PORT}/tv`);
  console.log('');
  console.log('  Phone page (open by scanning the QR on the TV):');
  if (primary) {
    console.log(`    ${httpsPort ? `https://${primary.address}:${httpsPort}` : `http://${primary.address}:${HTTP_PORT}`}/m`);
  }
  if (lan.length > 1) console.log(`    other interfaces: ${lan.map((l) => l.address).join(', ')}`);
  console.log('');
  console.log('  Note: phones need HTTPS for the camera. The TV page hands out the');
  console.log('  https:// address automatically. If the certificate warning appears,');
  console.log('  accept it once ("Advanced" → "Proceed") — see README for iOS steps.');
  console.log('  No HTTPS possible? Run `npm run tunnel` for a free public HTTPS URL.');
  console.log('');

  const shutdown = () => {
    log('shutting down');
    for (const room of registry.rooms.values()) registry.destroy(room.code);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

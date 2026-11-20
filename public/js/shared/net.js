/**
 * WebSocket / WebRTC relay client used by both the TV and the phone.
 *
 * Transport selection:
 *   - If `/api/net` is reachable (local server), use the WebSocket relay (LAN,
 *     works offline, lowest latency).
 *   - Otherwise (e.g. GitHub Pages, no backend), fall back to PeerJS WebRTC
 *     data channels using PeerJS's free cloud signaling. This needs internet
 *     but no backend and no paid infrastructure.
 *
 * Both transports expose the same events: status, welcome, peer, message, rtt,
 * fatal. Application code (app.js) is transport-agnostic.
 */
import { Emitter, clamp } from './util.js';
import { MSG } from './protocol.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomCode(len = 4) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

export function defaultRelayUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const override = new URLSearchParams(location.search).get('relay');
  if (override) return override;
  return `${proto}//${location.host}/ws`;
}

export class Relay extends Emitter {
  constructor({ role, code = null, url = defaultRelayUrl(), autoReconnect = true, transport = 'auto' }) {
    super();
    this.role = role;
    this.code = code ? String(code).toUpperCase() : null;
    this.url = url;
    this.autoReconnect = autoReconnect;
    this.transportPref = transport;
    this.transport = null; // 'ws' | 'peer'
    this.ws = null;
    this.peer = null;
    this.dataConn = null;
    this.attempts = 0;
    this.closedByUs = false;
    this.state = 'idle';
    this.peerPresent = false;
    this.rtt = null;
    this._retryTimer = 0;
    this._pingTimer = 0;
    this._connectResolvers = [];
    this._peerCode = null; // TV's published peer id
  }

  get paired() { return this.state === 'ready' && this.peerPresent; }

  _setState(state, detail = null) {
    if (this.state === state && !detail) return;
    this.state = state;
    this.emit('status', { state, detail, code: this.code, peer: this.peerPresent, rtt: this.rtt });
  }

  async connect() {
    if (this.transport === null) {
      await this._pickTransport();
    }
    if (this.transport === 'peer' && this.role === 'tv') {
      this.code = null; // always fresh code in PeerJS mode
    }
    this.closedByUs = false;
    clearTimeout(this._retryTimer);
    if (this.transport === 'ws') this._connectWS();
    else this._connectPeer();
  }

  async _pickTransport() {
    if (this.transportPref === 'ws') { this.transport = 'ws'; return; }
    if (this.transportPref === 'peer') { this.transport = 'peer'; return; }
    // auto: probe /api/net
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch('/api/net', { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) { this.transport = 'ws'; return; }
    } catch {}
    this.transport = 'peer';
  }

  // ------------------------------------------------------------------ WS
  _connectWS() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this._setState(this.attempts > 0 ? 'reconnecting' : 'connecting');

    let ws;
    try { ws = new WebSocket(this.url); }
    catch (err) { this._scheduleRetry(err?.message || 'bad url'); return; }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempts = 0;
      this._sendRawWS({
        t: MSG.HELLO, role: this.role, v: 1, code: this.code,
        ua: navigator.userAgent.slice(0, 160),
      });
      this._setState('waiting');
      this._startPingsWS();
    });

    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      this._handleWS(msg);
    });

    ws.addEventListener('close', () => {
      clearInterval(this._pingTimer);
      if (this.closedByUs) { this._setState('closed'); return; }
      this._scheduleRetry();
    });
    ws.addEventListener('error', () => {});
  }

  _handleWS(msg) {
    switch (msg.t) {
      case MSG.WELCOME: {
        this.code = msg.code;
        this.peerPresent = Boolean(msg.peer);
        this.state = 'ready';
        this.emit('welcome', msg);
        this._setState(this.peerPresent ? 'ready' : 'waiting');
        this._resolveConnect(true, msg);
        break;
      }
      case MSG.ERROR: {
        this.emit('fatal', msg);
        this._setState('error', msg.message || msg.code);
        if (msg.code === 'ROOM_NOT_FOUND') this.close();
        this._resolveConnect(false, msg);
        break;
      }
      case MSG.PEER: {
        this.emit('message', msg.data);
        break;
      }
      case MSG.PEER_JOINED: {
        this.peerPresent = true;
        this.emit('peer', { present: true, role: msg.role });
        this._setState('ready');
        break;
      }
      case MSG.PEER_LEFT: {
        this.peerPresent = false;
        this.emit('peer', { present: false, role: msg.role });
        this._setState('waiting');
        break;
      }
      case MSG.PONG: {
        if (typeof msg.ts === 'number') {
          this.rtt = clamp(Math.round(performance.now() - msg.ts), 0, 9999);
          this.emit('rtt', this.rtt);
        }
        break;
      }
      case MSG.PING:
        this._sendRawWS({ t: MSG.PONG, ts: msg.ts });
        break;
      default: break;
    }
  }

  _sendRawWS(obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
    }
    return false;
  }

  _startPingsWS() {
    clearInterval(this._pingTimer);
    const ping = () => this._sendRawWS({ t: MSG.PING, ts: performance.now() });
    this._pingTimer = setInterval(ping, 4000);
    setTimeout(ping, 300);
  }

  // ------------------------------------------------------------------ PeerJS
  _connectPeer() {
    if (typeof Peer === 'undefined') {
      this.emit('fatal', { t: MSG.ERROR, code: 'NO_PEERJS', message: 'PeerJS library not loaded' });
      this._setState('error', 'PeerJS unavailable');
      return;
    }
    this._setState(this.attempts > 0 ? 'reconnecting' : 'connecting');

    if (this.role === 'tv') this._connectPeerTV();
    else this._connectPeerMobile();
  }

  _connectPeerTV() {
    const makePeer = (code) => {
      const p = new Peer(code, { debug: 0 });
      p.on('open', (id) => {
        this.attempts = 0;
        this.peer = p;
        this.code = id;
        this._peerCode = id;
        this.peerPresent = false;
        this.state = 'ready';
        this.emit('welcome', { t: MSG.WELCOME, role: 'tv', code: id, peer: false, serverTime: Date.now() });
        this._setState('waiting');
        this._startPingsPeer();
      });
      p.on('connection', (conn) => {
        // replace stale connection
        if (this.dataConn && this.dataConn.open) {
          try { this.dataConn.close(); } catch {}
        }
        this.dataConn = conn;
        conn.on('open', () => {
          this.peerPresent = true;
          this.emit('peer', { present: true, role: 'mobile' });
          this._setState('ready');
          // welcome the phone
          try { conn.send({ t: MSG.WELCOME, role: 'mobile', code: this.code, peer: true, serverTime: Date.now() }); } catch {}
        });
        conn.on('data', (msg) => this._handlePeerData(msg, 'mobile'));
        conn.on('close', () => {
          if (this.dataConn === conn) {
            this.dataConn = null;
            this.peerPresent = false;
            this.emit('peer', { present: false, role: 'mobile' });
            this._setState('waiting');
          }
        });
        conn.on('error', () => {});
      });
      p.on('error', (err) => {
        if (err && err.type === 'unavailable-id') {
          // collision: regenerate code
          try { p.destroy(); } catch {}
          this.code = null;
          this._connectPeerTV();
          return;
        }
        this.emit('fatal', { t: MSG.ERROR, code: err?.type || 'PEER_ERROR', message: err?.message || 'peer error' });
        this._setState('error', err?.message || 'peer error');
      });
      p.on('disconnected', () => {
        if (!this.closedByUs) { try { p.reconnect(); } catch {} }
      });
    };

    if (!this.code) {
      this.code = randomCode();
    }
    makePeer(this.code);
  }

  _connectPeerMobile() {
    if (!this.code) {
      this.emit('fatal', { t: MSG.ERROR, code: 'NO_CODE', message: 'No room code provided' });
      this._setState('error', 'no code');
      return;
    }
    const p = new Peer();
    p.on('open', (id) => {
      this.peer = p;
      // connect to TV
      const conn = p.connect(this.code, { reliable: true });
      this.dataConn = conn;
      conn.on('open', () => {
        this.attempts = 0;
        // wait for welcome from TV (sent on open). If not received in 5s, retry.
        this._peerOpenTimer = setTimeout(() => {
          if (this.state !== 'ready') {
            this.emit('fatal', { t: MSG.ERROR, code: 'ROOM_NOT_FOUND', message: 'That code is not on screen' });
            this._setState('error', 'room not found');
            this.close();
          }
        }, 6000);
      });
      conn.on('data', (msg) => this._handlePeerData(msg, 'tv'));
      conn.on('close', () => {
        if (this.dataConn === conn) {
          this.dataConn = null;
          this.peerPresent = false;
          this.emit('peer', { present: false, role: 'tv' });
          this._setState('waiting');
          if (!this.closedByUs) this._scheduleRetry();
        }
      });
      conn.on('error', (err) => {
        this.emit('fatal', { t: MSG.ERROR, code: err?.type || 'PEER_ERROR', message: err?.message || 'peer error' });
        this._setState('error', err?.message || 'peer error');
        if (!this.closedByUs) this._scheduleRetry();
      });
    });
    p.on('error', (err) => {
      if (err && err.type === 'peer-unavailable') {
        this.emit('fatal', { t: MSG.ERROR, code: 'ROOM_NOT_FOUND', message: 'That code is not on screen' });
        this._setState('error', 'room not found');
        this.close();
      } else {
        this.emit('fatal', { t: MSG.ERROR, code: err?.type || 'PEER_ERROR', message: err?.message || 'peer error' });
        this._setState('error', err?.message || 'peer error');
      }
    });
    p.on('disconnected', () => {
      if (!this.closedByUs) { try { p.reconnect(); } catch {} }
    });
  }

  _handlePeerData(msg, from) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === MSG.WELCOME) {
      clearTimeout(this._peerOpenTimer);
      this.code = msg.code || this.code;
      this.peerPresent = Boolean(msg.peer);
      this.state = 'ready';
      this.emit('welcome', msg);
      this._setState(this.peerPresent ? 'ready' : 'waiting');
      this._resolveConnect(true, msg);
      if (this.peerPresent) {
        this.emit('peer', { present: true, role: from });
      }
      return;
    }
    if (msg.t === MSG.PING) {
      this._sendRawPeer({ t: MSG.PONG, ts: msg.ts, serverTime: Date.now() });
      return;
    }
    if (msg.t === MSG.PONG) {
      if (typeof msg.ts === 'number') {
        this.rtt = clamp(Math.round(performance.now() - msg.ts), 0, 9999);
        this.emit('rtt', this.rtt);
      }
      return;
    }
    if (msg.t === 'peer-joined' || msg.t === MSG.PEER_JOINED) {
      this.peerPresent = true;
      this.emit('peer', { present: true, role: msg.role || from });
      this._setState('ready');
      return;
    }
    if (msg.t === 'peer-left' || msg.t === MSG.PEER_LEFT) {
      this.peerPresent = false;
      this.emit('peer', { present: false, role: msg.role || from });
      this._setState('waiting');
      return;
    }
    // application message
    this.emit('message', msg);
  }

  _sendRawPeer(obj) {
    if (this.dataConn && this.dataConn.open) {
      try { this.dataConn.send(obj); return true; } catch { return false; }
    }
    return false;
  }

  _startPingsPeer() {
    clearInterval(this._pingTimer);
    const ping = () => {
      if (this.dataConn && this.dataConn.open) {
        this.dataConn.send({ t: MSG.PING, ts: performance.now() });
      }
    };
    this._pingTimer = setInterval(ping, 4000);
    setTimeout(ping, 500);
  }

  // ------------------------------------------------------------------ common
  _scheduleRetry(reason) {
    this.attempts++;
    const delay = clamp(400 * Math.pow(1.7, this.attempts - 1), 400, 6000);
    this._setState('reconnecting', reason || null);
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      if (!this.closedByUs) this.connect();
    }, delay);
  }

  _resolveConnect(ok, msg) {
    const list = this._connectResolvers;
    this._connectResolvers = [];
    for (const r of list) (ok ? r.resolve : r.reject)(msg);
  }

  waitForWelcome(timeout = 9000) {
    if (this.state === 'ready' || (this.state === 'waiting' && this.code)) {
      return Promise.resolve({ code: this.code, peer: this.peerPresent });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._connectResolvers = this._connectResolvers.filter((r) => r.resolve !== done);
        reject(new Error('relay-timeout'));
      }, timeout);
      const done = (msg) => { clearTimeout(timer); resolve(msg); };
      const fail = (err) => { clearTimeout(timer); reject(err); };
      this._connectResolvers.push({ resolve: done, reject: fail });
    });
  }

  send(obj) {
    if (this.transport === 'ws') return this._sendRawWS(obj);
    return this._sendRawPeer(obj);
  }

  close(sayBye = false) {
    this.closedByUs = true;
    clearTimeout(this._retryTimer);
    clearInterval(this._pingTimer);
    if (sayBye) this.send({ t: MSG.BYE });
    try { this.dataConn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    try { this.ws?.close(1000, 'client closed'); } catch {}
    this.ws = null; this.peer = null; this.dataConn = null;
    this._setState('closed');
  }
}

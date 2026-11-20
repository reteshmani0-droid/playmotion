/**
 * Wire protocol shared by the TV, the phone and the relay.
 *
 * Design goal: send *tracking data*, never video. A full 2-hand frame is
 * ~600 bytes, so a phone can stream at 30 Hz using well under 25 KB/s.
 */

export const PROTOCOL_VERSION = 1;

export const MSG = {
  // relay control
  HELLO: 'hello',
  WELCOME: 'welcome',
  ERROR: 'error',
  PEER: 'peer',
  PEER_JOINED: 'peer-joined',
  PEER_LEFT: 'peer-left',
  PING: 'ping',
  PONG: 'pong',
  BYE: 'bye',

  // phone -> tv
  HANDS: 'hands',
  STATUS: 'status',
  PREVIEW: 'preview',
  CALIB: 'calib',
  HELLO_MOBILE: 'hello-mobile',

  // shared
  CMD: 'cmd',
  STATE: 'state',
  FX: 'fx',
  WANT_PREVIEW: 'want-preview',
};

/** Commands a phone may send to the TV. */
export const CMD = {
  PAUSE: 'pause',
  RESUME: 'resume',
  RESTART: 'restart',
  QUIT: 'quit',
  CALIBRATE: 'calibrate',
  START: 'start',
  SELECT: 'select',
};

/** Screen states the TV broadcasts so the phone UI can follow along. */
export const SCREEN = {
  MENU: 'menu',
  PAIRING: 'pairing',
  CALIBRATION: 'calibration',
  PLAYING: 'playing',
  PAUSED: 'paused',
  GAME_OVER: 'gameover',
  HOWTO: 'howto',
  SETTINGS: 'settings',
};

/** Landmark indices used for the blade + skeleton drawing. */
export const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_TIP: 20,
};

/** Bone pairs for the debug skeleton. */
export const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

/** Round to 4 decimals to keep packets small without visible precision loss. */
export function q(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Build a hands packet. Points are normalized camera coordinates (0..1),
 * origin top-left of the video frame, x to the right.
 * @param {Array} hands tracked hands
 * @param {{w:number,h:number,ts:number,fps:number,seq:number}} meta
 */
export function handsPacket(hands, meta) {
  return {
    t: MSG.HANDS,
    seq: meta.seq,
    ts: q(meta.ts),
    fps: Math.round(meta.fps || 0),
    frame: { w: meta.w, h: meta.h },
    hands: hands.map((h) => ({
      hand: h.hand,
      score: q(h.score),
      palm: [q(h.palm[0]), q(h.palm[1])],
      tip: [q(h.tip[0]), q(h.tip[1])],
      span: q(h.span),
      speed: q(h.speed),
      pts: h.pts.map(q),
    })),
  };
}

/** Validation for anything coming off the wire before it hits the renderer. */
export function isValidHands(msg) {
  if (!msg || msg.t !== MSG.HANDS || !Array.isArray(msg.hands)) return false;
  if (msg.hands.length > 2) return false;
  for (const h of msg.hands) {
    if (!h || !Array.isArray(h.palm) || h.palm.length !== 2) return false;
    const [x, y] = h.palm;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  }
  return true;
}

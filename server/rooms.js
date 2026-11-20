/**
 * Room / pairing registry for the TV <-> phone relay.
 *
 * One TV owns a room. A phone joins with the 4-letter code shown on the TV.
 * Rooms are pure signaling buckets: the server never looks inside the
 * hand-tracking payloads, it just forwards them to the other peer.
 */
import { randomInt } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O to avoid mis-reading
const ROOM_IDLE_TTL = 1000 * 60 * 30; // empty room kept for 30 min (TV refresh / re-pair)
const ROOM_HARD_TTL = 1000 * 60 * 60 * 12;

/** @typedef {{ id: string, code: string, tv: import('ws').WebSocket|null, mobile: import('ws').WebSocket|null, createdAt: number, lastSeen: number, previewWanted: boolean }} Room */

export class RoomRegistry {
  constructor(log = () => {}) {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    this.log = log;
    this._gc = setInterval(() => this.gc(), 60_000);
    this._gc.unref?.();
  }

  /** Create a fresh TV-owned room with a unique human-friendly code. */
  createRoom() {
    let code;
    let guard = 0;
    do {
      code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      guard++;
    } while (this.rooms.has(code) && guard < 500);
    if (this.rooms.has(code)) throw new Error('Could not allocate a room code');

    /** @type {Room} */
    const room = {
      id: code,
      code,
      tv: null,
      mobile: null,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      previewWanted: false,
    };
    this.rooms.set(code, room);
    this.log(`room created ${code}`);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').toUpperCase().trim());
  }

  /** Attach a socket to a room, replacing any stale peer of the same role. */
  attach(code, role, socket) {
    const room = this.get(code);
    if (!room) return null;
    const key = role === 'tv' ? 'tv' : 'mobile';
    const previous = room[key];
    if (previous && previous !== socket && previous.readyState === 1) {
      // A TV refresh / phone refresh should not orphan the pairing.
      try {
        previous.close(4001, 'replaced');
      } catch {}
    }
    room[key] = socket;
    room.lastSeen = Date.now();
    return room;
  }

  detach(room, role, socket) {
    if (!room) return;
    const key = role === 'tv' ? 'tv' : 'mobile';
    if (room[key] === socket) {
      room[key] = null;
      room.lastSeen = Date.now();
    }
  }

  /** Keep an empty room alive briefly so a TV refresh can reclaim its code. */
  orphan(code, ttl = 90_000) {
    const room = this.get(code);
    if (!room) return;
    room.lastSeen = Date.now();
    clearTimeout(room.orphanTimer);
    room.orphanTimer = setTimeout(() => {
      const r = this.get(code);
      if (r && !r.tv) this.destroy(code);
    }, ttl);
    room.orphanTimer.unref?.();
  }

  /** Re-attach a TV to a room it owned before a refresh. */
  reclaim(code, socket) {
    const room = this.get(code);
    if (!room) return null;
    if (room.tv && room.tv.readyState === 1 && room.tv !== socket) return null; // code in active use
    if (!room.mobile && Date.now() - room.lastSeen > 1000 * 60 * 20) return null;
    clearTimeout(room.orphanTimer);
    room.tv = socket;
    room.lastSeen = Date.now();
    return room;
  }

  destroy(code) {
    const room = this.get(code);
    if (!room) return;
    clearTimeout(room.orphanTimer);
    for (const ws of [room.tv, room.mobile]) {
      if (ws && ws.readyState === 1) {
        try {
          ws.close(4000, 'room closed');
        } catch {}
      }
    }
    this.rooms.delete(room.code);
    this.log(`room destroyed ${room.code}`);
  }

  gc() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      const idle = now - room.lastSeen;
      const age = now - room.createdAt;
      const empty = !room.tv && !room.mobile;
      if ((empty && idle > ROOM_IDLE_TTL) || age > ROOM_HARD_TTL) this.destroy(room.code);
    }
  }

  get stats() {
    let paired = 0;
    for (const r of this.rooms.values()) if (r.tv && r.mobile) paired++;
    return { rooms: this.rooms.size, paired };
  }
}

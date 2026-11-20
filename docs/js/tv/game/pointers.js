/**
 * Turns raw inputs (phone hand tracking, mouse, gamepad) into "blade" pointers
 * in logical game coordinates: smoothed position, measured velocity, and a
 * speed gate that decides when a movement is fast enough to slice.
 */
import { OneEuro, clamp, mapRange, damp } from '../../shared/util.js';
import { WORLD } from './config.js';

export const SLICE_SPEED = 880;      // px/s needed to cut
export const SLICE_SPEED_MIN = 620;  // hysteresis so trails don't stutter

export class Pointer {
  constructor(id, kind) {
    this.id = id;
    this.kind = kind;        // 'hand' | 'mouse' | 'pad'
    this.active = false;
    this.x = WORLD.w / 2;
    this.y = WORLD.h / 2;
    this.px = this.x;
    this.py = this.y;
    this.vx = 0;
    this.vy = 0;
    this.speed = 0;
    this.rawX = this.x;
    this.rawY = this.y;
    this.targetX = this.x;
    this.targetY = this.y;
    this.confidence = 1;
    this.hand = null;        // 'Left' | 'Right'
    this.span = 0.1;
    this.radius = 42;
    this.sliceArmed = false;
    this.moving = false;
    this.lastSampleAt = 0;
    this.lastSeen = 0;
    this.fx = new OneEuro({ minCutoff: 2.6, beta: 0.008, dCutoff: 1.4 });
    this.fy = new OneEuro({ minCutoff: 2.6, beta: 0.008, dCutoff: 1.4 });
    this.visible = false;
    this.opacity = 0;
  }
}

export class PointerManager {
  constructor() {
    /** @type {Map<string, Pointer>} */
    this.pointers = new Map();
    this.mirror = true;
    this.ranges = { x0: 0.14, x1: 0.86, y0: 0.1, y1: 0.82 };
    this.sensitivity = 1;
    this.handSmoothing = 0.5;
    this.time = 0;
    this.onHandSeen = null;
    this.mouse = new Pointer('mouse', 'mouse');
    this.mouse.down = false;
    this.pad = new Pointer('pad', 'pad');
    this.pad.visible = false;
    this._padPrev = { x: 0, y: 0 };
    this._handednessFlip = false;
    this.padEnabled = false;
  }

  setRanges(ranges) {
    if (!ranges) return;
    const minSpan = 0.22;
    let { x0, x1, y0, y1 } = ranges;
    // Keep the playable box sane even if a calibration went wrong.
    if (x1 - x0 < minSpan) {
      const c = (x0 + x1) / 2;
      x0 = c - minSpan / 2;
      x1 = c + minSpan / 2;
    }
    if (y1 - y0 < minSpan * 0.9) {
      const c = (y0 + y1) / 2;
      y0 = c - minSpan * 0.45;
      y1 = c + minSpan * 0.45;
    }
    this.ranges = {
      x0: clamp(x0, -0.2, 1),
      x1: clamp(x1, 0, 1.2),
      y0: clamp(y0, -0.2, 1),
      y1: clamp(y1, 0, 1.2),
    };
  }

  setSensitivity(v) {
    this.sensitivity = clamp(v, 0.5, 2);
  }

  /** Map a normalized camera point into logical screen space. */
  mapPoint(nx, ny) {
    const r = this.ranges;
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    const halfX = ((r.x1 - r.x0) / 2) / this.sensitivity;
    const halfY = ((r.y1 - r.y0) / 2) / this.sensitivity;
    // Ranges are stored in camera space, so mirror after normalising. That
    // keeps calibration valid when the player flips the mirror setting.
    const xNorm = mapRange(nx, cx - halfX, cx + halfX, 0, 1);
    const yNorm = mapRange(ny, cy - halfY, cy + halfY, 0, 1);
    const x = this.mirror ? 1 - xNorm : xNorm;
    return [x * WORLD.w, yNorm * WORLD.h];
  }

  /**
   * Feed a validated `hands` packet from the phone.
   * @param {{hands:Array, ts:number}} packet
   */
  ingestHands(packet, now) {
    const seen = new Set();
    for (const h of packet.hands) {
      const key = h.hand === 'Left' || h.hand === 'Right' ? h.hand : `hand${h.hand}`;
      seen.add(key);
      let p = this.pointers.get(key);
      if (!p) {
        p = new Pointer(key, 'hand');
        p.hand = h.hand;
        this.pointers.set(key, p);
      }
      const [x, y] = this.mapPoint(h.palm[0], h.palm[1]);
      // A tracking re-acquire far from the last sample must not drag the blade
      // across the screen (and slice everything on the way).
      const stale = !p.lastSampleAt || now - p.lastSampleAt > 260;
      const jumped = Math.hypot(x - p.targetX, y - p.targetY) > WORLD.w * 0.28;
      if (stale || jumped) {
        p.x = x;
        p.y = y;
        p.px = x;
        p.py = y;
        p.vx = 0;
        p.vy = 0;
        p.fx.reset(x);
        p.fy.reset(y);
      }
      p.targetX = x;
      p.targetY = y;
      p.rawX = x;
      p.rawY = y;
      p.confidence = h.score ?? 1;
      p.span = h.span ?? 0.1;
      p.radius = clamp(p.span * WORLD.w * 0.5, 34, 90);
      p.visible = true;
      p.active = true;
      p.lastSeen = now;
      p.lastSampleAt = now;
      if (this.onHandSeen) this.onHandSeen(p);
    }
    for (const [key, p] of this.pointers) {
      if (p.kind === 'hand' && !seen.has(key)) {
        // Keep it briefly so a single dropped frame does not blink the blade.
        if (now - p.lastSeen > 220) p.visible = false;
      }
    }
  }

  setMouse(clientX, clientY, view, down) {
    this.mouse.down = down;
    this.mouse.targetX = (clientX - view.offsetX) / view.scale;
    this.mouse.targetY = (clientY - view.offsetY) / view.scale;
    this.mouse.visible = true;
    this.mouse.active = true;
    this.mouse.lastSampleAt = this.time;
    this._mouseMoved = true;
  }

  setMouseVisible(v) {
    this.mouse.visible = v;
  }

  /** Poll a connected gamepad. Right stick drives a fallback blade. */
  pollGamepad(now) {
    const pads = navigator.getGamepads?.() || [];
    let gp = null;
    for (const p of pads) {
      if (p && p.connected) {
        gp = p;
        break;
      }
    }
    if (!gp) {
      this.padEnabled = false;
      this.pad.visible = false;
      return null;
    }
    this.padEnabled = true;
    const stickX = gp.axes[2] ?? 0;
    const stickY = gp.axes[3] ?? 0;
    const mag = Math.hypot(stickX, stickY);
    this.pad.visible = true;
    this.pad.active = true;
    if (mag > 0.2) {
      // Integrate stick into pointer space, slightly accelerated for reach.
      this.pad.targetX = clamp(this.pad.targetX + stickX * 1900 * (1 / 60), 0, WORLD.w);
      this.pad.targetY = clamp(this.pad.targetY + stickY * 1900 * (1 / 60), 0, WORLD.h);
      this.pad.sliceArmed = mag > 0.55;
      this.pad.lastSampleAt = now;
    } else {
      this.pad.sliceArmed = false;
    }
    return gp;
  }

  /** Advance smoothing/velocity. Call once per frame before rendering. */
  update(dt, now) {
    this.time = now;
    const all = [...this.pointers.values(), this.mouse, this.pad];
    for (const p of all) {
      const wasVisible = p.opacity > 0.01;
      const shouldShow = p.visible && (p.kind !== 'hand' || now - p.lastSeen < 400);
      p.opacity = damp(p.opacity, shouldShow ? 1 : 0, 0.25, dt);

      if (!shouldShow && p.kind === 'hand') {
        p.active = false;
        p.speed = 0;
        p.sliceArmed = false;
        continue;
      }
      if (p.kind === 'pad' && !this.padEnabled) continue;
      if (!wasVisible && shouldShow) {
        // Snap in to avoid a long glide from the last known point.
        p.fx.reset(p.targetX);
        p.fy.reset(p.targetY);
      }

      const nx = p.kind === 'hand'
        ? p.fx.filter(p.targetX, now)
        : damp(p.x, p.targetX, 0.55, dt);
      const ny = p.kind === 'hand'
        ? p.fy.filter(p.targetY, now)
        : damp(p.y, p.targetY, 0.55, dt);

      p.px = p.x;
      p.py = p.y;
      p.x = nx;
      p.y = ny;

      const instVx = dt > 0 ? (p.x - p.px) / dt : 0;
      const instVy = dt > 0 ? (p.y - p.py) / dt : 0;
      const a = 0.55;
      p.vx += (instVx - p.vx) * a;
      p.vy += (instVy - p.vy) * a;
      // Hands report at ~30 Hz; extrapolate the render position slightly so the
      // blade stays glued to the player's hand instead of trailing the network.
      if (p.kind === 'hand' && p.speed > 300) {
        const lead = Math.min(0.028, (now - p.lastSampleAt) / 1000);
        p.x = clamp(p.x + p.vx * lead, 0, WORLD.w);
        p.y = clamp(p.y + p.vy * lead, 0, WORLD.h);
      }
      p.speed = Math.hypot(p.vx, p.vy);
      p.moving = p.speed > 220;

      if (p.kind === 'hand') {
        if (p.speed > SLICE_SPEED) p.sliceArmed = true;
        else if (p.speed < SLICE_SPEED_MIN) p.sliceArmed = false;
      } else if (p.kind === 'mouse') {
        p.sliceArmed = p.down && p.speed > 180;
      }
    }
  }

  blades() {
    const out = [];
    for (const p of this.pointers.values()) if (p.opacity > 0.05) out.push(p);
    if (this.mouse.visible && this.mouse.active) out.push(this.mouse);
    if (this.pad.visible && this.pad.active) out.push(this.pad);
    return out;
  }

  clearHands() {
    for (const [k, p] of this.pointers) {
      if (p.kind === 'hand') {
        p.visible = false;
        p.active = false;
        this.pointers.delete(k);
      }
    }
  }
}

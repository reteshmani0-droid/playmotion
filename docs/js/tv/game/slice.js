/**
 * The blade trail: a tapered, glowing ribbon that follows hand movement and
 * fades out behind the player. Rendering only — collision lives in the engine.
 */
import { clamp } from '../../shared/util.js';

const TRAIL_LIFE = 0.17; // seconds a trail point survives

export class BladeTrail {
  constructor() {
    this.points = [];
    this.color = '#a9f4ff';
    this.maxPoints = 26;
  }

  reset() {
    this.points.length = 0;
  }

  push(x, y, t, speed = 0) {
    const last = this.points[this.points.length - 1];
    if (last) {
      const d = Math.hypot(x - last.x, y - last.y);
      // Interpolate on very fast swipes so the ribbon stays silky.
      const steps = Math.min(4, Math.floor(d / 90));
      for (let i = 1; i <= steps; i++) {
        const k = i / (steps + 1);
        this.points.push({ x: last.x + (x - last.x) * k, y: last.y + (y - last.y) * k, t: t - (1 - k) * 8, speed });
      }
    }
    this.points.push({ x, y, t, speed });
    if (this.points.length > this.maxPoints) this.points.splice(0, this.points.length - this.maxPoints);
  }

  prune(now) {
    const cutoff = now - TRAIL_LIFE * 1000;
    while (this.points.length && this.points[0].t < cutoff) this.points.shift();
  }

  draw(ctx, now, widthScale = 1) {
    const pts = this.points;
    if (pts.length < 2) return;
    const n = pts.length;
    const baseWidth = 26 * widthScale;

    // Build the two edges of the ribbon.
    const left = [];
    const right = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(n - 1, i + 1)];
      let dx = next.x - prev.x;
      let dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const age = clamp(1 - (now - p.t) / (TRAIL_LIFE * 1000), 0, 1);
      const along = i / (n - 1);
      const taper = Math.pow(along, 0.7);            // thin tail, thick head
      const speedW = clamp(p.speed / 2600, 0.35, 1.4);
      const w = baseWidth * (0.12 + 0.88 * taper) * age * speedW;
      left.push({ x: p.x - dy * w, y: p.y + dx * w });
      right.push({ x: p.x + dy * w, y: p.y - dx * w });
    }

    const trace = (ctx2) => {
      ctx2.beginPath();
      ctx2.moveTo(left[0].x, left[0].y);
      for (let i = 1; i < n; i++) ctx2.lineTo(left[i].x, left[i].y);
      for (let i = n - 1; i >= 0; i--) ctx2.lineTo(right[i].x, right[i].y);
      ctx2.closePath();
    };

    ctx.save();
    // outer glow
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = this.color;
    ctx.save();
    ctx.translate(0, 0);
    ctx.scale(1.02, 1.02);
    trace(ctx);
    ctx.fill();
    ctx.restore();

    // main blade body
    ctx.globalAlpha = 0.75;
    const head = pts[n - 1];
    const tail = pts[0];
    const grad = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.35, this.color);
    grad.addColorStop(1, '#ffffff');
    ctx.fillStyle = grad;
    trace(ctx);
    ctx.fill();

    // white hot core
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.save();
    const cx = head.x;
    const cy = head.y;
    ctx.translate(cx, cy);
    ctx.scale(0.42, 0.42);
    ctx.translate(-cx, -cy);
    trace(ctx);
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }
}

/** Soft glowing cursor shown when the blade is idle (helps aiming). */
export function drawCursor(ctx, x, y, radius, opacity, color = '#d8fbff', slicing = false) {
  if (opacity <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = opacity;
  const r = Math.max(10, radius * 0.5);
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.28, 'rgba(190,245,255,0.45)');
  g.addColorStop(1, 'rgba(140,220,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  if (!slicing) {
    ctx.globalAlpha = opacity * 0.7;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.72, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.globalAlpha = opacity * 0.9;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

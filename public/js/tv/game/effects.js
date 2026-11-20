/**
 * Juice, sparks, smoke, splat decals, score pop-ups, shake and flash.
 * Everything is pooled / capped so a long combo cannot tank the frame rate.
 */
import { rand, clamp } from '../../shared/util.js';

const TAU = Math.PI * 2;

export class Effects {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.particles = [];
    this.popups = [];
    this.rings = [];
    this.shake = { time: 0, mag: 0 };
    this.flashColor = '#fff';
    this.flashAlpha = 0;
    this.maxParticles = 900;

    // Decals live on a half-res layer and fade slowly.
    this.decalScale = 0.5;
    this.decal = document.createElement('canvas');
    this.decal.width = Math.ceil(w * this.decalScale);
    this.decal.height = Math.ceil(h * this.decalScale);
    this.decalCtx = this.decal.getContext('2d');
  }

  reset() {
    this.particles.length = 0;
    this.popups.length = 0;
    this.rings.length = 0;
    this.shake.time = 0;
    this.shake.mag = 0;
    this.flashAlpha = 0;
    this.decalCtx.clearRect(0, 0, this.decal.width, this.decal.height);
  }

  shakeScreen(mag, time = 0.35) {
    this.shake.mag = Math.max(this.shake.mag, mag);
    this.shake.time = Math.max(this.shake.time, time);
  }

  flash(color, alpha = 0.5) {
    this.flashColor = color;
    this.flashAlpha = Math.max(this.flashAlpha, alpha);
  }

  /** Colored juice burst + a splat decal behind the action. */
  juice(x, y, colors, amount = 26, scale = 1) {
    for (let i = 0; i < amount; i++) {
      if (this.particles.length >= this.maxParticles) break;
      const a = rand(0, TAU);
      const speed = rand(80, 720) * scale;
      this.particles.push({
        type: 'juice',
        x, y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - rand(40, 220),
        gravity: 1250,
        drag: 0.9,
        size: rand(4, 16) * scale,
        life: 0,
        maxLife: rand(0.45, 1.15),
        color: colors[(Math.random() * colors.length) | 0],
        rot: rand(0, TAU),
        spin: rand(-8, 8),
      });
    }
    // quick bright splash ring
    this.rings.push({ x, y, r: 8 * scale, maxR: 90 * scale, life: 0, maxLife: 0.32, color: colors[0], width: 10 * scale });
    this.decalSplat(x, y, colors, scale);
  }

  decalSplat(x, y, colors, scale = 1) {
    const ctx = this.decalCtx;
    const dx = x * this.decalScale;
    const dy = y * this.decalScale;
    ctx.save();
    ctx.translate(dx, dy);
    ctx.scale(this.decalScale * scale, this.decalScale * scale);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = colors[0];
    const blobs = 5 + ((Math.random() * 4) | 0);
    for (let i = 0; i < blobs; i++) {
      const a = rand(0, TAU);
      const d = rand(0, 54);
      const r = rand(16, 54);
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * d, Math.sin(a) * d, r, r * rand(0.6, 1.1), a, 0, TAU);
      ctx.fill();
    }
    // flying droplets
    ctx.globalAlpha = 0.45;
    for (let i = 0; i < 14; i++) {
      const a = rand(0, TAU);
      const d = rand(50, 150);
      ctx.beginPath();
      ctx.arc(Math.cos(a) * d, Math.sin(a) * d, rand(2, 7), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  sparks(x, y, colors, amount = 18, scale = 1) {
    for (let i = 0; i < amount; i++) {
      if (this.particles.length >= this.maxParticles) break;
      const a = rand(0, TAU);
      const speed = rand(200, 900) * scale;
      this.particles.push({
        type: 'spark',
        x, y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        gravity: 420,
        drag: 0.86,
        size: rand(2, 5.5) * scale,
        life: 0,
        maxLife: rand(0.25, 0.65),
        color: colors[(Math.random() * colors.length) | 0],
        rot: 0,
        spin: 0,
      });
    }
  }

  smoke(x, y, amount = 16, scale = 1) {
    for (let i = 0; i < amount; i++) {
      if (this.particles.length >= this.maxParticles) break;
      const a = rand(0, TAU);
      const d = rand(0, 30) * scale;
      this.particles.push({
        type: 'smoke',
        x: x + Math.cos(a) * d,
        y: y + Math.sin(a) * d,
        vx: Math.cos(a) * rand(20, 160) * scale,
        vy: Math.sin(a) * rand(20, 140) * scale - 40,
        gravity: -40,
        drag: 0.94,
        size: rand(26, 70) * scale,
        life: 0,
        maxLife: rand(0.7, 1.6),
        color: 'rgba(70,70,80,0.5)',
        rot: rand(0, TAU),
        spin: rand(-1, 1),
      });
    }
  }

  popup(x, y, text, { color = '#ffe9a8', size = 46, life = 0.95, stroke = 'rgba(0,0,0,0.55)', drift = -120 } = {}) {
    this.popups.push({ x, y, text, color, size, life: 0, maxLife: life, stroke, drift });
  }

  shockwave(x, y, color, maxR = 260, width = 18) {
    this.rings.push({ x, y, r: 10, maxR, life: 0, maxLife: 0.5, color, width });
  }

  /** @param {number} dt seconds */
  update(dt) {
    const p = this.particles;
    for (let i = p.length - 1; i >= 0; i--) {
      const q = p[i];
      q.life += dt;
      if (q.life >= q.maxLife) {
        p[i] = p[p.length - 1];
        p.pop();
        continue;
      }
      q.vy += q.gravity * dt;
      const drag = Math.pow(q.drag ?? 0.95, dt * 60);
      q.vx *= drag;
      q.vy *= drag;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.rot += q.spin * dt;
    }

    for (let i = this.popups.length - 1; i >= 0; i--) {
      const q = this.popups[i];
      q.life += dt;
      q.y += q.drift * dt;
      if (q.life >= q.maxLife) this.popups.splice(i, 1);
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life += dt;
      if (r.life >= r.maxLife) this.rings.splice(i, 1);
    }

    if (this.shake.time > 0) {
      this.shake.time = Math.max(0, this.shake.time - dt);
      if (this.shake.time === 0) this.shake.mag = 0;
    }
    if (this.flashAlpha > 0) this.flashAlpha = Math.max(0, this.flashAlpha - dt * 2.6);

    // Fade decals. Slow, so splats linger as dojo grime for a few seconds.
    const dctx = this.decalCtx;
    dctx.save();
    dctx.globalCompositeOperation = 'destination-out';
    dctx.fillStyle = 'rgba(0,0,0,0.0035)';
    dctx.fillRect(0, 0, this.decal.width, this.decal.height);
    dctx.restore();
  }

  get shakeOffset() {
    if (this.shake.time <= 0) return { x: 0, y: 0 };
    const k = this.shake.time * 22;
    return {
      x: Math.sin(k * 1.3) * this.shake.mag * (0.4 + Math.random() * 0.6),
      y: Math.cos(k * 1.7) * this.shake.mag * (0.4 + Math.random() * 0.6),
    };
  }

  drawDecals(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.decal, 0, 0, this.w, this.h);
    ctx.restore();
  }

  draw(ctx) {
    // rings
    for (const r of this.rings) {
      const t = clamp(r.life / r.maxLife, 0, 1);
      const rad = r.r + (r.maxR - r.r) * (1 - Math.pow(1 - t, 2));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * (1 - t * 0.6);
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    for (const q of this.particles) {
      const t = clamp(q.life / q.maxLife, 0, 1);
      if (q.type === 'smoke') {
        ctx.save();
        ctx.globalAlpha = (1 - t) * 0.5;
        ctx.fillStyle = q.color;
        ctx.beginPath();
        ctx.arc(q.x, q.y, q.size * (0.6 + t * 1.6), 0, TAU);
        ctx.fill();
        ctx.restore();
        continue;
      }
      if (q.type === 'spark') {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = q.color;
        ctx.beginPath();
        ctx.arc(q.x, q.y, q.size * (1 - t * 0.5), 0, TAU);
        ctx.fill();
        ctx.restore();
        continue;
      }
      // juice droplet: stretch along velocity
      const speed = Math.hypot(q.vx, q.vy);
      const stretch = clamp(1 + speed / 900, 1, 2.4);
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate(Math.atan2(q.vy, q.vx));
      ctx.globalAlpha = 1 - Math.pow(t, 2.2);
      ctx.fillStyle = q.color;
      ctx.beginPath();
      ctx.ellipse(0, 0, q.size * stretch * 0.55, q.size * 0.5, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    for (const q of this.popups) {
      const t = clamp(q.life / q.maxLife, 0, 1);
      const pop = t < 0.18 ? 0.7 + (t / 0.18) * 0.45 : 1.15 - (t - 0.18) * 0.18;
      ctx.save();
      ctx.globalAlpha = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      ctx.translate(q.x, q.y);
      ctx.scale(pop, pop);
      ctx.font = `900 ${q.size}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = q.size * 0.16;
      ctx.strokeStyle = q.stroke;
      ctx.strokeText(q.text, 0, 0);
      ctx.fillStyle = q.color;
      ctx.fillText(q.text, 0, 0);
      ctx.restore();
    }
  }

  drawFlash(ctx) {
    if (this.flashAlpha <= 0.001) return;
    ctx.save();
    ctx.globalAlpha = this.flashAlpha;
    ctx.fillStyle = this.flashColor;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.restore();
  }
}

/** Small shared helpers. No dependencies, no build step. */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};
export const rand = (min, max) => min + Math.random() * (max - min);
export const randInt = (min, max) => Math.floor(rand(min, max + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** Frame-rate independent exponential smoothing. */
export function damp(current, target, smoothing, dt) {
  const t = 1 - Math.pow(1 - smoothing, dt * 60);
  return current + (target - current) * t;
}

/** Map value from one range to another, clamped. */
export function mapRange(v, inMin, inMax, outMin, outMax) {
  const t = clamp((v - inMin) / (inMax - inMin || 1e-6), 0, 1);
  return outMin + (outMax - outMin) * t;
}

/**
 * One Euro filter — low jitter when still, low lag when moving.
 * Used on both the phone (landmarks) and the TV (pointer rendering).
 */
export class OneEuro {
  constructor({ minCutoff = 1.2, beta = 0.03, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset(value = null) {
    this.x = value;
    this.dx = 0;
    this.t = null;
    return this;
  }

  filter(value, t) {
    if (this.x === null || this.t === null) {
      this.x = value;
      this.t = t;
      this.dx = 0;
      return value;
    }
    const dt = Math.max(1e-3, (t - this.t) / 1000);
    this.t = t;
    const rawDx = (value - this.x) / dt;
    const dAlpha = OneEuro.alpha(this.dCutoff, dt);
    this.dx = this.dx + dAlpha * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const alpha = OneEuro.alpha(cutoff, dt);
    this.x = this.x + alpha * (value - this.x);
    return this.x;
  }
}

export function formatScore(n) {
  return Math.max(0, Math.round(n)).toLocaleString('en-US');
}

/** localStorage with a namespace + safe fallbacks (TV browsers can be locked down). */
export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`fn.${key}`);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`fn.${key}`, JSON.stringify(value));
    } catch {}
  },
};

/** Simple event emitter. */
export class Emitter {
  constructor() {
    this._listeners = new Map();
  }
  on(evt, fn) {
    if (!this._listeners.has(evt)) this._listeners.set(evt, new Set());
    this._listeners.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) {
    this._listeners.get(evt)?.delete(fn);
  }
  emit(evt, ...args) {
    const set = this._listeners.get(evt);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`listener for ${evt} failed`, err);
      }
    }
  }
}

/** rAF-throttled resize observer helper. */
export function onResize(el, cb) {
  let raf = 0;
  const run = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(cb);
  };
  window.addEventListener('resize', run);
  window.addEventListener('orientationchange', run);
  if (el && 'ResizeObserver' in window) new ResizeObserver(run).observe(el);
  run();
}

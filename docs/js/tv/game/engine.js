/**
 * Game host.
 *
 * Owns the canvas, the rAF loop, pointer smoothing, effects, audio and view.
 * The actual game simulation lives in a pluggable module (see games/). The host
 * just drives update/render and forwards events.
 */
import { WORLD } from './config.js';
import { Effects } from './effects.js';
import { PointerManager } from './pointers.js';
import { clamp, rand } from '../../shared/util.js';
import { drawCursor } from './slice.js';
import { createFruitNinja } from '../games/fruitninja.js';
import { createWhackAMole } from '../games/whackamole.js';
import { createStarCatcher } from '../games/starcatcher.js';
import { createBalloonPop } from '../games/balloonpop.js';
import { createColorRush } from '../games/colorrush.js';
import { createCricket } from '../games/cricket.js';

const GAME_FACTORIES = {
  fruitninja: createFruitNinja,
  whackamole: createWhackAMole,
  starcatcher: createStarCatcher,
  balloonpop: createBalloonPop,
  colorrush: createColorRush,
  cricket: createCricket,
};

export const GAME_LIST = [
  { id: 'fruitninja', title: 'Fruit Ninja', subtitle: 'Slice flying fruit with your hands', color: '#ff3d68', emoji: '🍉', players: '1-2' },
  { id: 'whackamole', title: 'Whack-a-Mole', subtitle: 'Smash the moles, dodge the bombs', color: '#8b5a3c', emoji: '🐹', players: '1' },
  { id: 'starcatcher', title: 'Star Catcher', subtitle: 'Catch falling stars before they land', color: '#a9f4ff', emoji: '⭐', players: '1' },
  { id: 'balloonpop', title: 'Balloon Pop', subtitle: 'Pop the balloons, avoid the bombs', color: '#ffd76a', emoji: '🎈', players: '1' },
  { id: 'colorrush', title: 'Color Rush', subtitle: 'Touch only the matching color', color: '#ff7bc4', emoji: '🎨', players: '1' },
  { id: 'cricket', title: 'Cricket', subtitle: '3D batting — time your swing', color: '#3a7d3a', emoji: '🏏', players: '1' },
];

export class Game {
  constructor({ canvas, audio, settings, onEvent }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.audio = audio;
    this.settings = settings || {};
    this.onEvent = onEvent || (() => {});

    this.effects = new Effects(WORLD.w, WORLD.h);
    this.pointers = new PointerManager();

    this.current = null;     // active game module
    this.currentId = null;
    this.mode = 'hub';       // 'hub' | 'playing'
    this.paused = false;
    this.running = true;
    this.lastTs = 0;
    this.now = 0;
    this.view = { scale: 1, offsetX: 0, offsetY: 0, dpr: 1 };
    this._renderScale = 1;
    this._hudClock = 0;

    this.state = this._freshState();

    this.dust = Array.from({ length: 46 }, () => ({
      x: rand(0, WORLD.w), y: rand(0, WORLD.h), r: rand(0.8, 3.4),
      vy: rand(-16, -4), vx: rand(-6, 6), a: rand(0.04, 0.2),
    }));

    this.resize();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _freshState() {
    return { score: 0, lives: 3, combo: 0, comboTimer: 0, maxCombo: 0, sliced: 0, missed: 0, time: 0, running: false };
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(320, window.innerWidth);
    const cssH = Math.max(240, window.innerHeight);
    let bw = Math.round(cssW * dpr);
    let bh = Math.round(cssH * dpr);
    const cap = 2560;
    if (bw > cap) { const k = cap / bw; bw = cap; bh = Math.round(bh * k); }
    this.canvas.width = bw;
    this.canvas.height = bh;
    const cssScale = Math.min(cssW / WORLD.w, cssH / WORLD.h);
    this.view = { scale: cssScale, offsetX: (cssW - WORLD.w * cssScale) / 2, offsetY: (cssH - WORLD.h * cssScale) / 2, dpr };
    this._renderScale = Math.min(bw / WORLD.w, bh / WORLD.h);
    this._renderOffset = { x: (bw - WORLD.w * this._renderScale) / 2, y: (bh - WORLD.h * this._renderScale) / 2 };
  }

  clientToWorld(clientX, clientY) {
    return [(clientX - this.view.offsetX) / this.view.scale, (clientY - this.view.offsetY) / this.view.scale];
  }

  emit(name, data) { try { this.onEvent(name, data); } catch (err) { console.error('game event failed', name, err); } }

  get isPlaying() { return this.mode === 'playing' && !!this.current; }

  setGame(id) {
    if (this.current) { try { this.current.cleanup?.(); } catch {} }
    const factory = GAME_FACTORIES[id] || GAME_FACTORIES.fruitninja;
    this.current = factory();
    this.currentId = id;
    this.current.init(this);
    this.state = this.current.state;
  }

  startGame() {
    if (!this.current) this.setGame('fruitninja');
    this.mode = 'playing';
    this.paused = false;
    this.effects.reset();
    const fn = this.current?.start;
    if (typeof fn === 'function') fn.call(this.current);
    this.state = this.current.state;
    this.state.running = true;
    this.emit('start');
  }

  startClassic() { this.startGame(); }
  startPractice() {
    if (!this.current || this.currentId !== 'fruitninja') this.setGame('fruitninja');
    this.mode = 'playing';
    this.paused = false;
    this.effects.reset();
    const fn = this.current?.startPractice;
    if (typeof fn === 'function') fn.call(this.current);
    this.state = this.current.state;
    this.state.running = true;
  }

  enterAttract() {
    if (!this.current) this.setGame('fruitninja');
    this.mode = 'hub';
    this.paused = false;
    this.current.enterAttract?.();
    this.state = this.current.state;
  }

  pause() {
    if (this.mode !== 'playing') return;
    this.paused = true;
    this.audio?.duck(true);
    this.emit('paused');
  }

  resume() {
    this.paused = false;
    this.audio?.duck(false);
    this.emit('resumed');
  }

  quit() {
    this.mode = 'hub';
    this.paused = false;
    if (this.current) this.current.enterAttract?.();
    this.emit('quit');
  }

  restart() {
    if (!this.current) this.setGame('fruitninja');
    this.startGame();
  }

  _loop(ts) {
    if (!this.running) return;
    requestAnimationFrame(this._loop);
    const now = ts;
    let dt = this.lastTs ? (now - this.lastTs) / 1000 : 1 / 60;
    this.lastTs = now;
    this.now = now;
    dt = clamp(dt, 0, 1 / 20);

    this.pointers.update(dt, now);

    if (!this.paused) {
      this.effects.update(dt);
      if (this.mode === 'playing' && this.current) {
        this.current.update(dt, this);
        this.state = this.current.state;
        if (!this.current.state.running && !this.paused) {
          // game signaled end via emit already; keep rendering
        }
      } else if (this.mode === 'hub' && this.current) {
        this.current.update?.(dt, this);
      }
    }

    this._render(now);

    this._hudClock += dt;
    if (this._hudClock > 0.08) {
      this._hudClock = 0;
      this.emit('hud', this.state);
    }
  }

  _render(now) {
    const ctx = this.ctx;
    const canvas = this.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05060b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const shake = this.effects.shakeOffset;
    ctx.setTransform(
      this._renderScale, 0, 0, this._renderScale,
      this._renderOffset.x + shake.x * this._renderScale,
      this._renderOffset.y + shake.y * this._renderScale,
    );
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, WORLD.w, WORLD.h);
    ctx.clip();

    if (this.mode === 'hub') {
      // Neutral animated backdrop behind the game selector.
      const g = ctx.createLinearGradient(0, 0, 0, WORLD.h);
      g.addColorStop(0, '#12082a');
      g.addColorStop(1, '#05060b');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, WORLD.w, WORLD.h);
      // floating motes
      const t = this.now / 1000;
      ctx.fillStyle = 'rgba(255, 215, 106, 0.25)';
      for (let i = 0; i < 40; i++) {
        const x = (i * 137.5 + t * 12) % WORLD.w;
        const y = (i * 97.3 + t * 6) % WORLD.h;
        ctx.beginPath();
        ctx.arc(x, y, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (this.current) {
      this.current.render(ctx, this);
    }

    // Generic hand/mouse cursors (only while playing).
    if (this.mode === 'playing') {
      for (const b of this.pointers.blades()) {
        const slicing = b.speed > 640;
        if (!slicing) {
          const color = b.kind === 'hand' && b.hand === 'Left' ? '#ffe9a8' : '#d8fbff';
          drawCursor(ctx, b.x, b.y, b.radius || 46, b.opacity * 0.75, color, false);
        }
      }
    }

    this.effects.draw(ctx);
    this.effects.drawFlash(ctx);
    ctx.restore();
  }

  destroy() { this.running = false; }
}

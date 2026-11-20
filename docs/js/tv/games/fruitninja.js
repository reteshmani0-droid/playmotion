/**
 * Fruit Ninja game module.
 *
 * Self-contained simulation + rendering for the classic slice game. The host
 * (engine.js) owns the canvas, pointers, effects, audio and view; this module
 * only mutates its own state and emits events through `host.emit`.
 */
import { WORLD, RULES, difficultyAt, FRUIT_BY_ID } from '../game/config.js';
import { Fruit, Half, Spawner, segmentHitsCircle, fruitJuiceColors, fruitScore } from '../game/fruit.js';
import { SpriteCache, bakeBackground, drawBombSpark } from '../game/art.js';
import { BladeTrail } from '../game/slice.js';
import { clamp, rand } from '../../shared/util.js';

export function createFruitNinja() {
  const state = {
    score: 0, lives: RULES.lives, combo: 0, comboTimer: 0, comboWindow: RULES.comboWindow, maxCombo: 0,
    sliced: 0, missed: 0, time: 0, difficulty: 0, practiceSliced: 0, running: false,
  };

  let host = null;
  let mode = 'attract'; // 'attract' | 'practice' | 'classic'
  /** @type {Fruit[]} */ let fruits = [];
  /** @type {Half[]} */ let halves = [];
  const trails = new Map();
  const cosmeticTrails = [];
  const spawner = new Spawner();
  const sprites = new SpriteCache();
  let bg = null;
  let attractTimer = 1.0;
  let attractSliceTimer = 2.2;
  let pendingEnd = null;

  function reset() {
    fruits.length = 0;
    halves.length = 0;
    trails.clear();
    cosmeticTrails.length = 0;
    spawner.reset();
    attractTimer = 1.0;
    attractSliceTimer = 2.2;
    pendingEnd = null;
    state.score = 0; state.lives = RULES.lives; state.combo = 0; state.comboTimer = 0;
    state.maxCombo = 0; state.sliced = 0; state.missed = 0; state.time = 0;
    state.difficulty = 0; state.practiceSliced = 0; state.running = false;
    if (host) host.effects.reset();
  }

  function setMode(m) {
    mode = m;
    reset();
  }

  function startClassic() {
    setMode('classic');
    state.running = true;
    spawner.timer = 1.45;
    host.emit('start');
  }

  function startPractice() {
    setMode('practice');
    state.running = true;
    spawner.timer = 0.9;
  }

  function enterAttract() {
    setMode('attract');
  }

  function pause() { /* host handles paused flag */ }
  function resume() { /* host handles */ }

  function update(dt, h) {
    host = h;
    if (!bg) bg = bakeBackground(WORLD.w, WORLD.h);

    // Pointer smoothing is handled by the host; we only read blades.
    if (pendingEnd && h.now >= pendingEnd.at) {
      const reason = pendingEnd.reason;
      pendingEnd = null;
      state.running = false;
      h.audio?.duck(true);
      h.emit('gameover', {
        reason, score: state.score, sliced: state.sliced, maxCombo: state.maxCombo,
        missed: state.missed, time: state.time,
      });
      return;
    }

    const practice = mode === 'practice';
    const attract = mode === 'attract';
    const live = state.running;

    if (attract) {
      updateAttract(dt, h);
      return;
    }

    const difficulty = practice
      ? { spawnInterval: 1.5, waveMin: 1, waveMax: 1, bombChance: 0, speedMul: 0.72, gravityMul: 0.72, t: 0 }
      : difficultyAt(state.time);

    if (live) {
      if (!practice) {
        state.time += dt;
        state.difficulty = difficulty.t;
        h.audio?.setIntensity(difficulty.t);
      }
      spawner.update(dt, difficulty, {
        practice, allowBombs: !practice,
        onSpawn: (f) => {
          if (attract && fruits.length > 7) return;
          fruits.push(f);
          if (f.isBomb) h.effects.sparks(f.x, f.y, ['#ffb03a', '#ff5a1f'], 6, 1.5);
        },
      });

      if (state.comboTimer > 0) {
        state.comboTimer -= dt;
        if (state.comboTimer <= 0) {
          const n = state.combo;
          state.combo = 0;
          state.comboTimer = 0;
          if (n >= 2) h.emit('combo-end', { count: n });
        }
      }
    }

    const gravityMul = practice ? 0.72 : difficulty.gravityMul;
    for (let i = fruits.length - 1; i >= 0; i--) {
      const f = fruits[i];
      f.update(dt, gravityMul);
      if (live && !practice && !f.isBomb && !f.sliced && !f.counted && f.vy > 0 && f.y - f.radius > WORLD.h + 10) {
        f.counted = true;
        missedFruit(h);
      }
      if (f.dead) fruits.splice(i, 1);
    }
    for (let i = halves.length - 1; i >= 0; i--) {
      const hh = halves[i];
      hh.update(dt);
      if (hh.dead) halves.splice(i, 1);
    }

    if (!live) return;

    const blades = h.pointers.blades();
    for (const b of blades) {
      let trail = trails.get(b.id);
      if (!trail) {
        trail = new BladeTrail();
        trail.color = b.kind === 'hand' && b.hand === 'Left' ? '#ffe9a8' : '#a9f4ff';
        trails.set(b.id, trail);
      }
      const speed = b.speed;
      const pushing = b.sliceArmed && speed > 300;
      if (pushing) {
        trail.push(b.x, b.y, h.now, speed);
        checkHits(b, trail, practice, h);
      }
    }
    for (const [id, trail] of trails) {
      const liveBlade = blades.some((b) => b.id === id);
      if (!liveBlade) trail.reset();
    }
  }

  function checkHits(blade, trail, practice, h) {
    const x1 = blade.px, y1 = blade.py, x2 = blade.x, y2 = blade.y;
    const moveDist = Math.hypot(x2 - x1, y2 - y1);
    if (moveDist > 420) return;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const speed = blade.speed;
    for (let i = fruits.length - 1; i >= 0; i--) {
      const f = fruits[i];
      if (f.sliced) continue;
      const r = f.radius * 0.94;
      if (!segmentHitsCircle(x1, y1, x2, y2, f.x, f.y, r)) continue;
      slice(f, angle, speed, practice, h);
    }
  }

  function slice(fruit, angle, speed, practice, h) {
    fruit.sliced = true;
    const colors = fruitJuiceColors(fruit.id_);
    const scale = clamp(fruit.radius / 60, 0.8, 1.4);
    const attract = mode === 'attract';

    if (fruit.isBomb) {
      explode(fruit, colors, scale, h);
      fruits.splice(fruits.indexOf(fruit), 1);
      if (!practice) {
        state.running = false;
        pendingEnd = { reason: 'bomb', at: h.now + 900 };
        h.emit('bomb');
      }
      return;
    }

    halves.push(new Half(fruit, 'a', angle, speed), new Half(fruit, 'b', angle, speed));
    fruits.splice(fruits.indexOf(fruit), 1);

    h.effects.juice(fruit.x, fruit.y, colors, Math.round(26 * scale), scale);
    h.effects.sparks(fruit.x, fruit.y, ['#ffffff', colors[0]], Math.round(10 * scale), scale * 0.8);

    if (attract) return;

    h.effects.shakeScreen(6 * scale, 0.18);
    h.audio?.playSplat(fruit.id_);
    h.audio?.playSlice(clamp(speed / 2600, 0.4, 1.5));

    if (practice) {
      state.practiceSliced++;
      h.emit('practice-slice', { count: state.practiceSliced, x: fruit.x, y: fruit.y });
      h.effects.popup(fruit.x, fruit.y - 40, 'NICE!', { color: '#b6ffcf', size: 44 });
      return;
    }

    const combo = bumpCombo();
    state.sliced++;
    const base = fruitScore(fruit.id_);
    const points = Math.round(base * (1 + 0.25 * (combo - 1)));
    state.score += points;
    h.effects.popup(fruit.x, fruit.y - fruit.radius * 0.4, `+${points}`, {
      color: combo > 1 ? '#ffe066' : '#fff6df',
      size: combo > 1 ? 52 : 44,
    });

    if (combo >= 3) {
      h.effects.shockwave(fruit.x, fruit.y, '#ffd76a', 220 + combo * 26, 12);
      h.audio?.playCombo(combo);
      h.effects.popup(fruit.x, fruit.y - fruit.radius - 50, `COMBO ×${combo}`, {
        color: '#ffd76a', size: 40 + Math.min(22, combo * 3), life: 0.8,
      });
    } else if (combo === 2) {
      h.audio?.playCombo(2);
    }

    h.emit('slice', { type: fruit.id_, points, combo, x: fruit.x, y: fruit.y, speed });
  }

  function explode(fruit, colors, scale, h) {
    h.effects.flash('#fff4d6', 0.9);
    h.effects.flash('#ff7a2f', 0.5);
    h.effects.shakeScreen(38, 0.85);
    h.effects.juice(fruit.x, fruit.y, ['#ffb03a', '#ff5a1f', '#3a3f48'], 46, scale * 1.4);
    h.effects.sparks(fruit.x, fruit.y, ['#fff7c0', '#ffb03a', '#ff4a1f'], 70, scale * 1.8);
    h.effects.smoke(fruit.x, fruit.y, 24, scale * 1.5);
    h.effects.shockwave(fruit.x, fruit.y, '#ffcf7a', 720, 42);
    h.effects.shockwave(fruit.x, fruit.y, '#ff5a1f', 460, 26);
    h.audio?.playBomb();
    h.effects.popup(fruit.x, fruit.y - 100, 'BOOM!', { color: '#ff9a5c', size: 96, life: 1.4 });
  }

  function bumpCombo() {
    state.combo = state.comboTimer > 0 ? state.combo + 1 : 1;
    state.comboTimer = RULES.comboWindow;
    state.maxCombo = Math.max(state.maxCombo, state.combo);
    return state.combo;
  }

  function missedFruit(h) {
    if (mode !== 'classic') return;
    state.missed++;
    state.lives = Math.max(0, state.lives - 1);
    state.combo = 0;
    state.comboTimer = 0;
    h.audio?.playStrike();
    h.effects.flash('#ff2f4f', 0.22);
    h.effects.shakeScreen(10, 0.25);
    h.effects.popup(WORLD.w / 2, WORLD.h - 120, 'MISSED!', { color: '#ff7b8a', size: 64, life: 1.1 });
    h.emit('miss', { lives: state.lives });
    if (state.lives <= 0) {
      state.running = false;
      pendingEnd = { reason: 'missed', at: h.now + 700 };
    }
  }

  function updateAttract(dt, h) {
    spawner.update(dt, { spawnInterval: 1.5, waveMin: 1, waveMax: 2, bombChance: 0, speedMul: 0.85, gravityMul: 0.85, t: 0 }, {
      practice: true, allowBombs: false,
      onSpawn: (f) => { if (fruits.length <= 7) fruits.push(f); },
    });
    for (let i = fruits.length - 1; i >= 0; i--) {
      const f = fruits[i];
      f.update(dt, 0.85);
      if (f.dead || f.y > WORLD.h + 200) fruits.splice(i, 1);
    }
    for (let i = halves.length - 1; i >= 0; i--) {
      const hh = halves[i];
      hh.update(dt);
      if (hh.dead) halves.splice(i, 1);
    }
    attractSliceTimer -= dt;
    if (attractSliceTimer <= 0) {
      attractSliceTimer = rand(1.6, 3.4);
      const candidates = fruits.filter((f) => !f.sliced && f.y < WORLD.h * 0.72 && f.y > WORLD.h * 0.1);
      if (candidates.length) {
        const f = candidates[(Math.random() * candidates.length) | 0];
        const angle = rand(-0.9, 0.9);
        slice(f, angle, 2400, false, h);
        const trail = new BladeTrail();
        trail.color = '#a9f4ff';
        const dx = Math.cos(angle), dy = Math.sin(angle);
        for (let i = 0; i <= 8; i++) {
          const k = i / 8;
          trail.push(f.x - dx * 260 + dx * 520 * k, f.y - dy * 260 + dy * 520 * k, h.now - (8 - i) * 9, 2400);
        }
        cosmeticTrails.push({ trail, createdAt: h.now });
      }
    }
    // prune cosmetic trails
    for (let i = cosmeticTrails.length - 1; i >= 0; i--) {
      if (h.now - cosmeticTrails[i].createdAt > 600) cosmeticTrails.splice(i, 1);
    }
  }

  function render(ctx, h) {
    if (!bg) bg = bakeBackground(WORLD.w, WORLD.h);
    ctx.drawImage(bg, 0, 0, WORLD.w, WORLD.h);

    h.effects.drawDecals(ctx);
    // dust handled by host? Host draws a generic background; keep fruit dust minimal.
    for (const hh of halves) {
      ctx.save();
      ctx.translate(hh.x, hh.y);
      ctx.rotate(hh.rot);
      sprites.draw(ctx, hh.typeId, hh.side, hh.radius, hh.alpha);
      ctx.restore();
    }
    for (const f of fruits) {
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot);
      sprites.draw(ctx, f.id_, 'whole', f.radius);
      if (f.isBomb) drawBombSpark(ctx, f.radius, 0, h.now / 1000 + f.wobble, f.radius / 56);
      ctx.restore();
    }
    // Blade trails.
    for (const b of h.pointers.blades()) {
      const trail = trails.get(b.id);
      if (trail) {
        const widthScale = b.kind === 'hand' ? clamp(b.span * WORLD.w * 0.5 / 46, 0.8, 1.8) : 1;
        trail.draw(ctx, h.now, widthScale);
      }
    }
    for (const ct of cosmeticTrails) ct.trail.draw(ctx, h.now, 1.1);

    h.effects.draw(ctx);

    h.effects.drawFlash(ctx);
  }

  function isOver() { return !state.running && mode === 'classic'; }

  return {
    id: 'fruitninja',
    title: 'Fruit Ninja',
    state,
    init(h) { host = h; bg = bakeBackground(WORLD.w, WORLD.h); reset(); },
    setMode, startClassic, startPractice, enterAttract,
    update(dt, h) { host = h; update(dt, h); },
    render(ctx, h) { host = h; render(ctx, h); },
    isOver,
    get mode() { return mode; },
    get fruits() { return fruits; },
  };
}

import { WORLD } from '../game/config.js';
import { clamp, rand, randInt } from '../../shared/util.js';

export function createColorRush() {
  const PALETTE = [
    { name: 'RED', color: '#ff4b5c' },
    { name: 'BLUE', color: '#4bb3ff' },
    { name: 'GREEN', color: '#5fe07f' },
    { name: 'YELLOW', color: '#ffd76a' },
    { name: 'PINK', color: '#ff7bc4' },
  ];
  const state = { score: 0, lives: 3, combo: 0, comboTimer: 0, comboWindow: 0.9, maxCombo: 0, sliced: 0, missed: 0, time: 0, running: false, hits: 0 };
  let host = null;
  let elapsed = 0;
  let targetColor = PALETTE[0];
  let nextRoundAt = 0;
  let round = 0;
  let targets = []; // {x,y,r,color,good, hit, born}
  let spawnTimer = 0;
  let pendingEnd = null;

  function reset() {
    targets.length = 0;
    elapsed = 0;
    round = 0;
    pendingEnd = null;
    state.score = 0; state.lives = 3; state.combo = 0; state.comboTimer = 0;
    state.maxCombo = 0; state.sliced = 0; state.missed = 0; state.time = 0;
    state.running = false; state.hits = 0;
    if (host) host.effects.reset();
    pickTarget();
    nextRoundAt = 0;
  }

  function pickTarget() {
    targetColor = PALETTE[randInt(0, PALETTE.length - 1)];
  }

  function start() { reset(); state.running = true; }

  function spawnTarget() {
    const good = Math.random() < 0.45;
    const color = good ? targetColor : PALETTE[randInt(0, PALETTE.length - 1)];
    // ensure wrong color differs
    let c = color;
    if (!good) {
      do { c = PALETTE[randInt(0, PALETTE.length - 1)]; } while (c.name === targetColor.name);
    }
    targets.push({
      x: rand(160, WORLD.w - 160),
      y: rand(200, WORLD.h - 200),
      r: rand(46, 62),
      color: (good ? targetColor : c).color,
      good: good && (good ? targetColor : c).name === targetColor.name,
      name: (good ? targetColor : c).name,
      hit: false,
      born: elapsed,
      life: rand(1.6, 2.4),
      _maxLife: 0,
    });
    targets[targets.length-1]._maxLife = targets[targets.length-1].life;
  }

  function update(dt, h) {
    host = h;
    if (!state.running) return;
    elapsed += dt;
    state.time = elapsed;

    if (state.comboTimer > 0) {
      state.comboTimer -= dt;
      if (state.comboTimer <= 0) { state.combo = 0; state.comboTimer = 0; }
    }

    // change target color periodically
    nextRoundAt -= dt;
    if (nextRoundAt <= 0) {
      pickTarget();
      nextRoundAt = rand(4, 6);
      targets.length = 0;
    }

    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnTarget();
      spawnTimer = rand(0.5, 0.9);
    }

    for (let i = targets.length - 1; i >= 0; i--) {
      const t = targets[i];
      if (t.hit) {
        t.scale = (t.scale || 1) - dt * 4;
        if (t.scale <= 0) targets.splice(i, 1);
        continue;
      }
      t.life -= dt;
      if (t.life <= 0) {
        // expired without hit
        if (t.good) {
          state.missed++;
          state.lives = Math.max(0, state.lives - 1);
          h.effects.flash('#ff2f4f', 0.16);
          h.audio?.playStrike();
          h.emit('miss', { lives: state.lives });
          if (state.lives <= 0) endGame(h, 'lives');
        }
        targets.splice(i, 1);
        continue;
      }

      for (const blade of h.pointers.blades()) {
        const dist = Math.hypot(blade.x - t.x, blade.y - t.y);
        if (dist < t.r + 10 && (blade.speed > 220 || (blade.kind === 'mouse' && blade.down))) {
          t.hit = true;
          t.scale = 1;
          if (t.good) {
            state.hits++;
            state.sliced++;
            const combo = bumpCombo();
            const points = Math.round(12 * (1 + (combo - 1) * 0.4));
            state.score += points;
            h.effects.juice(t.x, t.y, [t.color, '#ffffff'], 18, 1);
            h.effects.shockwave(t.x, t.y, t.color, 140, 6);
            h.effects.popup(t.x, t.y - 30, `+${points}`, { color: '#fff6df', size: 36 });
            h.audio?.playSlice(1.0);
            if (combo >= 4) h.audio?.playCombo(combo);
            h.emit('slice', { type: 'color', points, combo, x: t.x, y: t.y, speed: blade.speed });
          } else {
            state.missed++;
            state.lives = Math.max(0, state.lives - 1);
            h.effects.flash('#ff2f4f', 0.2);
            h.effects.shakeScreen(8, 0.2);
            h.audio?.playStrike();
            h.effects.popup(t.x, t.y - 30, 'WRONG!', { color: '#ff7b8a', size: 40, life: 1 });
            h.emit('miss', { lives: state.lives });
            if (state.lives <= 0) endGame(h, 'lives');
          }
          break;
        }
      }
    }

    if (elapsed >= 60) endGame(h, 'time');
    if (pendingEnd && h.now >= pendingEnd.at) {
      const reason = pendingEnd.reason;
      pendingEnd = null;
      state.running = false;
      h.audio?.duck(true);
      h.emit('gameover', { reason, score: state.score, sliced: state.sliced, maxCombo: state.maxCombo, missed: state.missed, time: Math.round(elapsed) });
    }
  }

  function bumpCombo() {
    state.combo = state.comboTimer > 0 ? state.combo + 1 : 1;
    state.comboTimer = 0.9;
    state.maxCombo = Math.max(state.maxCombo, state.combo);
    return state.combo;
  }

  function endGame(h, reason) {
    if (pendingEnd) return;
    state.running = false;
    h.audio?.duck(true);
    h.emit('gameover', { reason, score: state.score, sliced: state.sliced, maxCombo: state.maxCombo, missed: state.missed, time: Math.round(elapsed) });
  }

  function render(ctx, h) {
    const g = ctx.createLinearGradient(0, 0, 0, WORLD.h);
    g.addColorStop(0, '#1a0a2e'); g.addColorStop(1, '#0a1a1e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WORLD.w, WORLD.h);

    // prompt
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,246,233,0.7)';
    ctx.font = 'bold 28px system-ui';
    ctx.fillText('TOUCH THE COLOR', WORLD.w / 2, 70);
    ctx.fillStyle = targetColor.color;
    ctx.font = '900 64px system-ui';
    ctx.shadowColor = targetColor.color;
    ctx.shadowBlur = 24;
    ctx.fillText(targetColor.name, WORLD.w / 2, 140);
    ctx.shadowBlur = 0;

    for (const t of targets) {
      ctx.save();
      ctx.translate(t.x, t.y);
      const s = t.hit ? (t.scale || 1) : 1 + Math.sin(elapsed * 4 + t.born) * 0.06;
      ctx.scale(s, s);
      ctx.fillStyle = t.color;
      ctx.beginPath();
      ctx.arc(0, 0, t.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 3;
      ctx.stroke();
      // inner ring
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, t.r * 0.6, 0, Math.PI * 2);
      ctx.stroke();
      // timer ring
      const frac = t.life / (t._maxLife || 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, t.r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, frac));
      ctx.stroke();
      ctx.restore();
    }

    const remain = Math.max(0, 60 - elapsed);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(WORLD.w * 0.3, WORLD.h - 50, WORLD.w * 0.4, 14);
    ctx.fillStyle = '#ff7bc4';
    ctx.fillRect(WORLD.w * 0.3, WORLD.h - 50, WORLD.w * 0.4 * (remain / 60), 14);
    ctx.fillStyle = 'rgba(255,246,233,0.7)';
    ctx.font = 'bold 22px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.ceil(remain)}s`, WORLD.w / 2, WORLD.h - 60);

    ctx.textAlign = 'left';
    ctx.fillStyle = '#ff8b9a';
    ctx.font = 'bold 26px system-ui';
    ctx.fillText('♥'.repeat(Math.max(0, state.lives)), 40, 46);

    h.effects.draw(ctx);
    h.effects.drawFlash(ctx);
  }

  return {
    id: 'colorrush', title: 'Color Rush', state,
    init(h) { host = h; reset(); },
    start() { start(); },
    update(dt, h) { host = h; update(dt, h); },
    render(ctx, h) { host = h; render(ctx, h); },
    isOver() { return !state.running; },
    get mode() { return 'classic'; },
    get targets() { return targets; },
  };
}

import { WORLD } from '../game/config.js';
import { clamp, rand, randInt } from '../../shared/util.js';

export function createWhackAMole() {
  const state = { score: 0, lives: 3, combo: 0, comboTimer: 0, comboWindow: 0.9, maxCombo: 0, sliced: 0, missed: 0, time: 0, running: false, hits: 0 };
  let host = null;
  const holes = [];
  const COLS = 3, ROWS = 3;
  const HOLE_R = 78;
  let spawnTimer = 0;
  let elapsed = 0;
  let pendingEnd = null;
  let moles = []; // {x,y,r,type:'mole'|'bomb', life, maxLife, up, hit}

  function layout() {
    holes.length = 0;
    const marginX = 260, marginY = 200;
    const gw = (WORLD.w - marginX * 2) / (COLS - 1);
    const gh = (WORLD.h - marginY * 2) / (ROWS - 1);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        holes.push({ x: marginX + c * gw, y: marginY + r * gh });
      }
    }
  }

  function reset() {
    moles.length = 0;
    spawnTimer = 0.6;
    elapsed = 0;
    pendingEnd = null;
    state.score = 0; state.lives = 3; state.combo = 0; state.comboTimer = 0;
    state.maxCombo = 0; state.sliced = 0; state.missed = 0; state.time = 0;
    state.running = false; state.hits = 0;
    if (host) host.effects.reset();
  }

  function start() {
    reset();
    state.running = true;
    layout();
  }

  function update(dt, h) {
    host = h;
    if (!state.running) return;
    elapsed += dt;
    state.time = elapsed;

    // combo window
    if (state.comboTimer > 0) {
      state.comboTimer -= dt;
      if (state.comboTimer <= 0) { state.combo = 0; state.comboTimer = 0; }
    }

    // spawn
    spawnTimer -= dt;
    if (spawnTimer <= 0 && moles.filter(m => !m.hit).length < 3) {
      const hole = holes[randInt(0, holes.length - 1)];
      const isBomb = Math.random() < 0.18 && moles.filter(m => m.type === 'bomb').length === 0;
      moles.push({
        x: hole.x, y: hole.y, r: HOLE_R * 0.7,
        type: isBomb ? 'bomb' : 'mole',
        life: 0, maxLife: isBomb ? 1.1 : rand(0.9, 1.4),
        up: true, hit: false, scale: 0,
      });
      spawnTimer = rand(0.45, 0.85);
    }

    // update moles
    for (let i = moles.length - 1; i >= 0; i--) {
      const m = moles[i];
      m.life += dt;
      if (m.hit) {
        m.scale = Math.max(0, m.scale - dt * 4);
        if (m.scale <= 0) moles.splice(i, 1);
        continue;
      }
      // pop up then sink
      const t = m.life / m.maxLife;
      if (t < 0.18) m.scale = t / 0.18;
      else if (t > 0.75) m.scale = 1 - (t - 0.75) / 0.25;
      else m.scale = 1;
      if (m.life >= m.maxLife) {
        // missed mole
        if (m.type === 'mole') {
          state.missed++;
          state.lives = Math.max(0, state.lives - 1);
          h.effects.flash('#ff2f4f', 0.18);
          h.audio?.playStrike();
          h.emit('miss', { lives: state.lives });
          if (state.lives <= 0) endGame(h, 'lives');
        }
        moles.splice(i, 1);
        continue;
      }

      // hit detection
      for (const b of h.pointers.blades()) {
        const dist = Math.hypot(b.x - m.x, b.y - m.y);
        if (dist < m.r * 1.1 && (b.speed > 260 || (b.kind === 'mouse' && b.down))) {
          m.hit = true;
          m.scale = 1;
          if (m.type === 'bomb') {
            h.effects.flash('#fff4d6', 0.8);
            h.effects.shakeScreen(24, 0.6);
            h.audio?.playBomb();
            h.effects.popup(m.x, m.y - 40, 'BOOM!', { color: '#ff9a5c', size: 72, life: 1.2 });
            endGame(h, 'bomb');
            return;
          }
          state.hits++;
          state.sliced++;
          const combo = bumpCombo();
          const points = 10 * (1 + (combo - 1) * 0.4);
          state.score += Math.round(points);
          h.effects.juice(m.x, m.y, ['#ffe066', '#ff9d1c', '#ffffff'], 18, 1);
          h.effects.shockwave(m.x, m.y, '#ffd76a', 140, 8);
          h.effects.popup(m.x, m.y - 40, combo >= 3 ? `COMBO ×${combo}` : `+${Math.round(points)}`, {
            color: combo >= 3 ? '#ffd76a' : '#fff6df', size: combo >= 3 ? 46 : 38,
          });
          if (combo >= 3) { h.audio?.playCombo(combo); }
          else h.audio?.playSlice(1);
          h.emit('slice', { type: 'mole', points: Math.round(points), combo, x: m.x, y: m.y, speed: b.speed });
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
    if (reason === 'bomb') {
      pendingEnd = { reason: 'bomb', at: h.now + 700 };
    } else {
      h.audio?.duck(true);
      h.emit('gameover', { reason, score: state.score, sliced: state.sliced, maxCombo: state.maxCombo, missed: state.missed, time: Math.round(elapsed) });
    }
  }

  function render(ctx, h) {
    // background
    ctx.fillStyle = '#1a0f2e';
    ctx.fillRect(0, 0, WORLD.w, WORLD.h);
    // ground
    const g = ctx.createLinearGradient(0, WORLD.h * 0.55, 0, WORLD.h);
    g.addColorStop(0, '#2a1a40'); g.addColorStop(1, '#0a0614');
    ctx.fillStyle = g;
    ctx.fillRect(0, WORLD.h * 0.55, WORLD.w, WORLD.h * 0.45);

    // holes
    for (const hole of holes) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.ellipse(hole.x, hole.y + 8, HOLE_R, HOLE_R * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    // moles
    for (const m of moles) {
      ctx.save();
      ctx.translate(m.x, m.y);
      const s = m.scale;
      ctx.scale(s, s);
      if (m.type === 'bomb') {
        // bomb
        ctx.fillStyle = '#22252c';
        ctx.beginPath();
        ctx.arc(0, 0, m.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#0c0d11';
        ctx.lineWidth = 4;
        ctx.stroke();
        // fuse
        ctx.beginPath();
        ctx.moveTo(0, -m.r);
        ctx.quadraticCurveTo(m.r * 0.3, -m.r * 1.3, m.r * 0.15, -m.r * 1.5);
        ctx.strokeStyle = '#8c7a63';
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.fillStyle = '#ffb03a';
        ctx.beginPath();
        ctx.arc(m.r * 0.15, -m.r * 1.5, 6, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // mole body
        ctx.fillStyle = '#8b5a3c';
        ctx.beginPath();
        ctx.arc(0, 0, m.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#a87048';
        ctx.beginPath();
        ctx.arc(0, -m.r * 0.15, m.r * 0.78, 0, Math.PI * 2);
        ctx.fill();
        // eyes
        ctx.fillStyle = '#1a0f0a';
        ctx.beginPath();
        ctx.arc(-m.r * 0.28, -m.r * 0.1, 7, 0, Math.PI * 2);
        ctx.arc(m.r * 0.28, -m.r * 0.1, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(-m.r * 0.28 + 2, -m.r * 0.1 - 2, 2.5, 0, Math.PI * 2);
        ctx.arc(m.r * 0.28 + 2, -m.r * 0.1 - 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
        // nose
        ctx.fillStyle = '#ff7b8a';
        ctx.beginPath();
        ctx.arc(0, m.r * 0.18, 6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // timer bar
    const remain = Math.max(0, 60 - elapsed);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(WORLD.w * 0.3, 36, WORLD.w * 0.4, 14);
    ctx.fillStyle = '#ffd76a';
    ctx.fillRect(WORLD.w * 0.3, 36, WORLD.w * 0.4 * (remain / 60), 14);
    ctx.fillStyle = 'rgba(255,246,233,0.7)';
    ctx.font = 'bold 22px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.ceil(remain)}s`, WORLD.w / 2, 30);

    h.effects.draw(ctx);
    h.effects.drawFlash(ctx);
  }

  return {
    id: 'whackamole', title: 'Whack-a-Mole', state,
    init(h) { host = h; reset(); layout(); },
    start() { start(); },
    update(dt, h) { host = h; update(dt, h); },
    render(ctx, h) { host = h; render(ctx, h); },
    isOver() { return !state.running; },
    get mode() { return 'classic'; },
    get moles() { return moles; },
  };
}

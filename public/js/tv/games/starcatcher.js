import { WORLD } from '../game/config.js';
import { clamp, rand, randInt } from '../../shared/util.js';

export function createStarCatcher() {
  const state = { score: 0, lives: 3, combo: 0, comboTimer: 0, comboWindow: 0.8, maxCombo: 0, sliced: 0, missed: 0, time: 0, running: false, caught: 0 };
  let host = null;
  let elapsed = 0;
  let spawnTimer = 0;
  let pendingEnd = null;
  /** @type {Array} */ let items = []; // {x,y,vx,vy,r,type:'star'|'bomb'|'gem', caught}

  function reset() {
    items.length = 0;
    spawnTimer = 0.5;
    elapsed = 0;
    pendingEnd = null;
    state.score = 0; state.lives = 3; state.combo = 0; state.comboTimer = 0;
    state.maxCombo = 0; state.sliced = 0; state.missed = 0; state.time = 0;
    state.running = false; state.caught = 0;
    if (host) host.effects.reset();
  }

  function start() { reset(); state.running = true; }

  function spawn() {
    const isBomb = Math.random() < 0.16;
    const isGem = !isBomb && Math.random() < 0.2;
    const type = isBomb ? 'bomb' : isGem ? 'gem' : 'star';
    items.push({
      x: rand(120, WORLD.w - 120),
      y: -40,
      vx: rand(-60, 60),
      vy: rand(120, 260),
      r: type === 'bomb' ? 46 : type === 'gem' ? 34 : 26,
      type, caught: false, rot: rand(0, Math.PI * 2), spin: rand(-2, 2),
    });
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

    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawn();
      spawnTimer = rand(0.35, 0.7);
    }

    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      it.x += it.vx * dt;
      it.y += it.vy * dt;
      it.rot += it.spin * dt;
      it.vy += 40 * dt;
      if (it.x < 60 || it.x > WORLD.w - 60) it.vx *= -1;

      // catch detection
      if (!it.caught) {
        for (const b of h.pointers.blades()) {
          const dist = Math.hypot(b.x - it.x, b.y - it.y);
          if (dist < it.r + (b.radius || 40) * 0.55) {
            it.caught = true;
            if (it.type === 'bomb') {
              h.effects.flash('#fff4d6', 0.8);
              h.effects.shakeScreen(24, 0.6);
              h.audio?.playBomb();
              h.effects.popup(it.x, it.y, 'BOOM!', { color: '#ff9a5c', size: 72, life: 1.2 });
              endGame(h, 'bomb');
              return;
            }
            state.caught++;
            state.sliced++;
            const combo = bumpCombo();
            const base = it.type === 'gem' ? 25 : 10;
            const points = Math.round(base * (1 + (combo - 1) * 0.35));
            state.score += points;
            h.effects.juice(it.x, it.y, it.type === 'gem' ? ['#ffd76a', '#ff9d1c', '#fff'] : ['#a9f4ff', '#fff', '#ffe066'], 20, 1);
            h.effects.shockwave(it.x, it.y, '#ffd76a', 120, 6);
            h.effects.popup(it.x, it.y - 30, `+${points}`, { color: '#fff6df', size: 36 });
            h.audio?.playSlice(1.1);
            if (combo >= 4) h.audio?.playCombo(combo);
            h.emit('slice', { type: it.type, points, combo, x: it.x, y: it.y, speed: 0 });
            break;
          }
        }
      }

      if (it.caught) {
        it.scale = (it.scale || 1) - dt * 3;
        if ((it.scale || 0) <= 0) items.splice(i, 1);
        else it.y -= 60 * dt;
        continue;
      }

      // missed (fell past bottom)
      if (it.y - it.r > WORLD.h + 20) {
        if (it.type !== 'bomb') {
          state.missed++;
          state.lives = Math.max(0, state.lives - 1);
          h.effects.flash('#ff2f4f', 0.16);
          h.audio?.playStrike();
          h.emit('miss', { lives: state.lives });
          if (state.lives <= 0) endGame(h, 'lives');
        }
        items.splice(i, 1);
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
    state.comboTimer = 0.8;
    state.maxCombo = Math.max(state.maxCombo, state.combo);
    return state.combo;
  }

  function endGame(h, reason) {
    if (pendingEnd) return;
    state.running = false;
    if (reason === 'bomb') pendingEnd = { reason: 'bomb', at: h.now + 700 };
    else {
      h.audio?.duck(true);
      h.emit('gameover', { reason, score: state.score, sliced: state.sliced, maxCombo: state.maxCombo, missed: state.missed, time: Math.round(elapsed) });
    }
  }

  function render(ctx, h) {
    // sky gradient
    const g = ctx.createLinearGradient(0, 0, 0, WORLD.h);
    g.addColorStop(0, '#0b1a3a'); g.addColorStop(0.6, '#1a0f3a'); g.addColorStop(1, '#2a1040');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WORLD.w, WORLD.h);

    // stars background
    ctx.fillStyle = 'rgba(255,246,233,0.6)';
    for (let i = 0; i < 60; i++) {
      const x = (i * 137.5) % WORLD.w;
      const y = (i * 97.3) % WORLD.h;
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const it of items) {
      ctx.save();
      ctx.translate(it.x, it.y);
      ctx.rotate(it.rot);
      const s = it.caught ? (it.scale || 1) : 1;
      ctx.scale(s, s);
      if (it.type === 'bomb') {
        ctx.fillStyle = '#22252c';
        ctx.beginPath(); ctx.arc(0, 0, it.r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#0c0d11'; ctx.lineWidth = 4; ctx.stroke();
        ctx.fillStyle = '#ffb03a';
        ctx.beginPath(); ctx.arc(0, -it.r * 0.9, 5, 0, Math.PI * 2); ctx.fill();
      } else if (it.type === 'gem') {
        ctx.fillStyle = '#ffd76a';
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 - Math.PI / 4;
          const r = i % 2 === 0 ? it.r : it.r * 0.5;
          const x = Math.cos(a) * r, y = Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#fff3cf'; ctx.lineWidth = 2; ctx.stroke();
      } else {
        // star
        ctx.fillStyle = '#ffe89a';
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
          const r = i % 2 === 0 ? it.r : it.r * 0.45;
          const x = Math.cos(a) * r, y = Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#ffb03a'; ctx.lineWidth = 1.5; ctx.stroke();
      }
      ctx.restore();
    }

    // timer bar
    const remain = Math.max(0, 60 - elapsed);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(WORLD.w * 0.3, 36, WORLD.w * 0.4, 14);
    ctx.fillStyle = '#a9f4ff';
    ctx.fillRect(WORLD.w * 0.3, 36, WORLD.w * 0.4 * (remain / 60), 14);
    ctx.fillStyle = 'rgba(255,246,233,0.7)';
    ctx.font = 'bold 22px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.ceil(remain)}s`, WORLD.w / 2, 30);

    // lives
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ff8b9a';
    ctx.font = 'bold 26px system-ui';
    ctx.fillText('♥'.repeat(Math.max(0, state.lives)), 40, 46);

    h.effects.draw(ctx);
    h.effects.drawFlash(ctx);
  }

  return {
    id: 'starcatcher', title: 'Star Catcher', state,
    init(h) { host = h; reset(); },
    start() { start(); },
    update(dt, h) { host = h; update(dt, h); },
    render(ctx, h) { host = h; render(ctx, h); },
    isOver() { return !state.running; },
    get mode() { return 'classic'; },
    get items() { return items; },
  };
}

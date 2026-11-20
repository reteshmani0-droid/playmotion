import { WORLD } from '../game/config.js';
import { clamp, rand, randInt } from '../../shared/util.js';

export function createBalloonPop() {
  const state = { score: 0, lives: 3, combo: 0, comboTimer: 0, comboWindow: 0.85, maxCombo: 0, sliced: 0, missed: 0, time: 0, running: false, popped: 0 };
  let host = null;
  let elapsed = 0;
  let spawnTimer = 0;
  let pendingEnd = null;
  /** @type {Array} */ let balloons = [];

  function reset() {
    balloons.length = 0;
    spawnTimer = 0.4;
    elapsed = 0;
    pendingEnd = null;
    state.score = 0; state.lives = 3; state.combo = 0; state.comboTimer = 0;
    state.maxCombo = 0; state.sliced = 0; state.missed = 0; state.time = 0;
    state.running = false; state.popped = 0;
    if (host) host.effects.reset();
  }

  function start() { reset(); state.running = true; }

  const COLORS = ['#ff5a6e', '#ffd76a', '#a9f4ff', '#b6ffcf', '#ff9d6e', '#d8a8ff'];

  function spawn() {
    const isBomb = Math.random() < 0.14;
    balloons.push({
      x: rand(140, WORLD.w - 140),
      y: WORLD.h + 60,
      vx: rand(-40, 40),
      vy: rand(-150, -230),
      r: isBomb ? 44 : rand(38, 62),
      color: isBomb ? '#3a3f48' : COLORS[randInt(0, COLORS.length - 1)],
      bomb: isBomb,
      popped: false,
      scale: 1,
      wobble: rand(0, Math.PI * 2),
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
      spawnTimer = rand(0.3, 0.6);
    }

    for (let i = balloons.length - 1; i >= 0; i--) {
      const b = balloons[i];
      if (b.popped) {
        b.scale -= dt * 4;
        b.y -= 30 * dt;
        if (b.scale <= 0) balloons.splice(i, 1);
        continue;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vx += Math.sin(elapsed * 2 + b.wobble) * 8 * dt;
      if (b.x < 80 || b.x > WORLD.w - 80) b.vx *= -1;

      // pop detection: blade crosses the balloon
      for (const blade of h.pointers.blades()) {
        const dist = Math.hypot(blade.x - b.x, blade.y - b.y);
        if (dist < b.r + 12 && (blade.speed > 280 || (blade.kind === 'mouse' && blade.down))) {
          b.popped = true;
          if (b.bomb) {
            h.effects.flash('#fff4d6', 0.8);
            h.effects.shakeScreen(24, 0.6);
            h.audio?.playBomb();
            h.effects.popup(b.x, b.y, 'BOOM!', { color: '#ff9a5c', size: 72, life: 1.2 });
            endGame(h, 'bomb');
            return;
          }
          state.popped++;
          state.sliced++;
          const combo = bumpCombo();
          const points = Math.round(8 * (1 + (combo - 1) * 0.4));
          state.score += points;
          h.effects.juice(b.x, b.y, [b.color, '#ffffff', '#ffd76a'], 22, 1.1);
          h.effects.shockwave(b.x, b.y, b.color, 160, 8);
          h.effects.popup(b.x, b.y - 30, `+${points}`, { color: '#fff6df', size: 36 });
          h.audio?.playSlice(1.0);
          if (combo >= 4) h.audio?.playCombo(combo);
          h.emit('slice', { type: 'balloon', points, combo, x: b.x, y: b.y, speed: blade.speed });
          break;
        }
      }

      // escaped (reached top)
      if (!b.popped && b.y + b.r < -40) {
        balloons.splice(i, 1);
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
    state.comboTimer = 0.85;
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
    const g = ctx.createLinearGradient(0, 0, 0, WORLD.h);
    g.addColorStop(0, '#0a1a2e'); g.addColorStop(1, '#1a0a2e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WORLD.w, WORLD.h);

    // clouds
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    for (let i = 0; i < 8; i++) {
      const x = (i * 280 + elapsed * 8) % (WORLD.w + 200) - 100;
      const y = 120 + (i % 3) * 90;
      ctx.beginPath();
      ctx.ellipse(x, y, 90, 40, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const b of balloons) {
      ctx.save();
      ctx.translate(b.x, b.y);
      const s = b.popped ? b.scale : 1 + Math.sin(elapsed * 3 + b.wobble) * 0.04;
      ctx.scale(s, s);
      // balloon body
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.ellipse(0, 0, b.r * 0.85, b.r, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // shine
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.ellipse(-b.r * 0.25, -b.r * 0.3, b.r * 0.2, b.r * 0.3, -0.4, 0, Math.PI * 2);
      ctx.fill();
      // knot + string
      if (!b.popped) {
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.moveTo(-4, b.r); ctx.lineTo(4, b.r); ctx.lineTo(0, b.r + 8); ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, b.r + 8);
        ctx.quadraticCurveTo(Math.sin(elapsed * 2 + b.wobble) * 12, b.r + 60, 0, b.r + 120);
        ctx.stroke();
      }
      // bomb face
      if (b.bomb) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 34px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('💣', 0, 0);
      }
      ctx.restore();
    }

    const remain = Math.max(0, 60 - elapsed);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(WORLD.w * 0.3, 36, WORLD.w * 0.4, 14);
    ctx.fillStyle = '#b6ffcf';
    ctx.fillRect(WORLD.w * 0.3, 36, WORLD.w * 0.4 * (remain / 60), 14);
    ctx.fillStyle = 'rgba(255,246,233,0.7)';
    ctx.font = 'bold 22px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.ceil(remain)}s`, WORLD.w / 2, 30);

    ctx.textAlign = 'left';
    ctx.fillStyle = '#ff8b9a';
    ctx.font = 'bold 26px system-ui';
    ctx.fillText('♥'.repeat(Math.max(0, state.lives)), 40, 46);

    h.effects.draw(ctx);
    h.effects.drawFlash(ctx);
  }

  return {
    id: 'balloonpop', title: 'Balloon Pop', state,
    init(h) { host = h; reset(); },
    start() { start(); },
    update(dt, h) { host = h; update(dt, h); },
    render(ctx, h) { host = h; render(ctx, h); },
    isOver() { return !state.running; },
    get mode() { return 'classic'; },
    get balloons() { return balloons; },
  };
}

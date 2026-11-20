/**
 * Procedural art. Everything is drawn with Canvas 2D paths and baked into
 * offscreen sprites once at startup, so the game can render at 60 fps without
 * shipping a single image asset.
 *
 * Each fruit is baked in three flavours:
 *   whole  – the intact fruit
 *   a/b    – the two halves, showing a cut face along the slice line
 */

const TAU = Math.PI * 2;
const PAD = 1.34; // room for stems, leaves, fuse
const BAKE_SCALE = 2;

// Older TV browsers (Tizen 5 / webOS 4) may not have roundRect.
if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function roundRect(x, y, w, h, r) {
    const rr = Math.min(typeof r === 'number' ? r : 0, w / 2, h / 2);
    this.moveTo(x + rr, y);
    this.arcTo(x + w, y, x + w, y + h, rr);
    this.arcTo(x + w, y + h, x, y + h, rr);
    this.arcTo(x, y + h, x, y, rr);
    this.arcTo(x, y, x + w, y, rr);
    this.closePath();
    return this;
  };
}

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const shade = (hex, amount) => {
  const [r, g, b] = rgb(hex);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + 255 * amount)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
};

function sphere(ctx, R, light, base, dark, cx = 0, cy = 0) {
  const g = ctx.createRadialGradient(cx - R * 0.38, cy - R * 0.44, R * 0.06, cx, cy, R * 1.08);
  g.addColorStop(0, light);
  g.addColorStop(0.48, base);
  g.addColorStop(0.88, dark);
  g.addColorStop(1, shade(dark, -0.08));
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.fillStyle = g;
  ctx.fill();
}

function rim(ctx, R, color = 'rgba(0,0,0,0.28)', width = R * 0.055) {
  ctx.beginPath();
  ctx.arc(0, 0, R - width * 0.4, 0, TAU);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function gloss(ctx, R, alpha = 0.55) {
  ctx.save();
  ctx.rotate(-0.5);
  const g = ctx.createRadialGradient(-R * 0.34, -R * 0.44, 0, -R * 0.34, -R * 0.44, R * 0.55);
  g.addColorStop(0, `rgba(255,255,255,${alpha})`);
  g.addColorStop(0.55, `rgba(255,255,255,${alpha * 0.28})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.beginPath();
  ctx.ellipse(-R * 0.32, -R * 0.42, R * 0.46, R * 0.3, 0, 0, TAU);
  ctx.fillStyle = g;
  ctx.fill();
  // tiny specular hot spot
  ctx.beginPath();
  ctx.ellipse(-R * 0.46, -R * 0.5, R * 0.13, R * 0.08, -0.5, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fill();
  ctx.restore();
}

function speckle(ctx, R, count, color, maxR = 0.03, alpha = 0.5, spread = 0.82) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.98, 0, TAU);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * TAU;
    const d = Math.sqrt(Math.random()) * R * spread;
    const r = R * maxR * (0.4 + Math.random());
    ctx.beginPath();
    ctx.ellipse(Math.cos(a) * d, Math.sin(a) * d, r, r * (0.5 + Math.random() * 0.6), a, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Individual fruits
// ---------------------------------------------------------------------------

const FRUITS = {
  apple: {
    rind: '#c9202f',
    flesh: '#fbeccb',
    juice: ['#ff5a52', '#e12638', '#ffe6b8'],
    whole(ctx, R) {
      // Two-lobed apple silhouette with a dip at the top.
      ctx.beginPath();
      ctx.moveTo(0, R * 0.96);
      ctx.bezierCurveTo(-R * 0.42, R * 0.9, -R * 0.98, R * 0.44, -R * 0.9, -R * 0.1);
      ctx.bezierCurveTo(-R * 0.84, -R * 0.6, -R * 0.5, -R * 0.84, -R * 0.2, -R * 0.72);
      ctx.bezierCurveTo(-R * 0.06, -R * 0.66, R * 0.06, -R * 0.66, R * 0.2, -R * 0.72);
      ctx.bezierCurveTo(R * 0.5, -R * 0.84, R * 0.84, -R * 0.6, R * 0.9, -R * 0.1);
      ctx.bezierCurveTo(R * 0.98, R * 0.44, R * 0.42, R * 0.9, 0, R * 0.96);
      ctx.closePath();
      const g = ctx.createRadialGradient(-R * 0.35, -R * 0.42, R * 0.08, 0, R * 0.05, R * 1.1);
      g.addColorStop(0, '#ff8a72');
      g.addColorStop(0.35, '#f0343f');
      g.addColorStop(0.78, '#c4142c');
      g.addColorStop(1, '#80101f');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = R * 0.05;
      ctx.strokeStyle = 'rgba(60,0,10,0.32)';
      ctx.stroke();

      // vertical red streaks
      ctx.save();
      ctx.globalAlpha = 0.22;
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(i * R * 0.3, -R * 0.55);
        ctx.quadraticCurveTo(i * R * 0.42, R * 0.1, i * R * 0.26, R * 0.82);
        ctx.lineWidth = R * 0.07;
        ctx.strokeStyle = i % 2 ? '#ff9a7a' : '#8c0d1c';
        ctx.stroke();
      }
      ctx.restore();

      gloss(ctx, R, 0.5);
      speckle(ctx, R, 26, '#ffd9b0', 0.012, 0.25, 0.85);

      // stem
      ctx.beginPath();
      ctx.moveTo(0, -R * 0.66);
      ctx.quadraticCurveTo(R * 0.06, -R * 1.0, R * 0.16, -R * 1.12);
      ctx.lineWidth = R * 0.085;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#6b4020';
      ctx.stroke();

      // leaf
      ctx.save();
      ctx.translate(R * 0.26, -R * 0.94);
      ctx.rotate(-0.45);
      ctx.beginPath();
      ctx.ellipse(R * 0.3, 0, R * 0.36, R * 0.17, 0, 0, TAU);
      const lg = ctx.createLinearGradient(0, -R * 0.2, 0, R * 0.2);
      lg.addColorStop(0, '#8ed24b');
      lg.addColorStop(1, '#3f7d24');
      ctx.fillStyle = lg;
      ctx.fill();
      ctx.restore();
    },
    flesh(ctx, R) {
      fleshPlate(ctx, R, [
        ['#fff8e6', '#f6e2b8', '#e5c58c'],
        '#ffd9a0',
      ]);
      // seeds + core
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#5a3a1e';
      for (const [x, y, rot] of [
        [-R * 0.28, -R * 0.1, -0.5],
        [R * 0.28, -R * 0.1, 0.5],
        [0, -R * 0.22, 0],
      ]) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rot);
        ctx.beginPath();
        ctx.ellipse(0, 0, R * 0.055, R * 0.095, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(0, -R * 0.03);
      ctx.quadraticCurveTo(-R * 0.16, -R * 0.12, -R * 0.02, -R * 0.24);
      ctx.lineWidth = R * 0.03;
      ctx.strokeStyle = 'rgba(160,110,50,0.45)';
      ctx.stroke();
    },
  },

  watermelon: {
    rind: '#2e7d32',
    flesh: '#ff3d68',
    juice: ['#ff3d68', '#ff7ba6', '#39a94b'],
    whole(ctx, R) {
      sphere(ctx, R, '#7ec850', '#3d9440', '#14531f');
      // stripes
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.995, 0, TAU);
      ctx.clip();
      ctx.strokeStyle = 'rgba(12,64,26,0.85)';
      ctx.lineCap = 'round';
      for (let i = -3; i <= 3; i++) {
        const x = i * R * 0.33;
        ctx.beginPath();
        ctx.moveTo(x * 0.75, -R);
        ctx.bezierCurveTo(x * 1.25, -R * 0.4, x * 1.25, R * 0.4, x * 0.7, R);
        ctx.lineWidth = R * (i % 2 ? 0.1 : 0.14);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = '#a8e06a';
      for (let i = -2; i <= 2; i++) {
        const x = i * R * 0.33 + R * 0.16;
        ctx.beginPath();
        ctx.moveTo(x * 0.8, -R);
        ctx.bezierCurveTo(x * 1.2, -R * 0.35, x * 1.2, R * 0.35, x * 0.75, R);
        ctx.lineWidth = R * 0.05;
        ctx.stroke();
      }
      ctx.restore();
      gloss(ctx, R, 0.4);
      rim(ctx, R, 'rgba(0,30,10,0.35)');
    },
    flesh(ctx, R) {
      // outer green rind ring
      ctx.beginPath();
      ctx.ellipse(0, R * 0.02, R * 0.97, R * 0.42, 0, 0, TAU);
      ctx.fillStyle = '#2e7d32';
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, R * 0.02, R * 0.9, R * 0.36, 0, 0, TAU);
      ctx.fillStyle = '#eaf6d8';
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.84, R * 0.32, 0, 0, TAU);
      const g = ctx.createRadialGradient(0, -R * 0.06, R * 0.05, 0, 0, R * 0.9);
      g.addColorStop(0, '#ff7b9c');
      g.addColorStop(0.5, '#ff2f5e');
      g.addColorStop(1, '#d21644');
      ctx.fillStyle = g;
      ctx.fill();
      // seeds
      ctx.fillStyle = '#2a1010';
      const seeds = [
        [-0.52, -0.08], [-0.3, -0.17], [0, -0.2], [0.3, -0.17], [0.52, -0.08],
        [-0.4, 0.06], [-0.15, 0.1], [0.15, 0.1], [0.4, 0.06],
      ];
      for (const [x, y] of seeds) {
        ctx.save();
        ctx.translate(x * R, y * R);
        ctx.rotate(x * 0.8);
        ctx.beginPath();
        ctx.ellipse(0, 0, R * 0.045, R * 0.07, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    },
  },

  orange: {
    rind: '#f07a12',
    flesh: '#ffb547',
    juice: ['#ffb13b', '#ff8a1f', '#ffe6a8'],
    whole(ctx, R) {
      sphere(ctx, R, '#ffd166', '#ff9a1f', '#cf5c05');
      speckle(ctx, R, 90, '#b34d00', 0.016, 0.3);
      speckle(ctx, R, 40, '#ffe4a3', 0.012, 0.3);
      gloss(ctx, R, 0.45);
      // stem nub
      ctx.beginPath();
      ctx.ellipse(0, -R * 0.92, R * 0.13, R * 0.08, 0, 0, TAU);
      ctx.fillStyle = '#7a4a12';
      ctx.fill();
      // little leaf
      ctx.save();
      ctx.translate(R * 0.1, -R * 0.95);
      ctx.rotate(-0.5);
      ctx.beginPath();
      ctx.ellipse(R * 0.26, 0, R * 0.3, R * 0.13, 0, 0, TAU);
      ctx.fillStyle = '#4f9a2e';
      ctx.fill();
      ctx.restore();
      rim(ctx, R, 'rgba(120,50,0,0.22)');
    },
    flesh(ctx, R) {
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.9, R * 0.35, 0, 0, TAU);
      ctx.fillStyle = '#ffd08a';
      ctx.fill();
      // segments
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.84, R * 0.31, 0, 0, TAU);
      ctx.clip();
      for (let i = -4; i <= 4; i++) {
        ctx.beginPath();
        ctx.moveTo(0, -R * 0.45);
        ctx.lineTo(i * R * 0.22, R * 0.45);
        ctx.lineWidth = R * 0.07;
        ctx.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx.stroke();
      }
      const g = ctx.createRadialGradient(0, 0, R * 0.04, 0, 0, R * 0.9);
      g.addColorStop(0, 'rgba(255,214,120,0.9)');
      g.addColorStop(1, 'rgba(255,150,40,0.75)');
      ctx.fillStyle = g;
      ctx.fillRect(-R, -R * 0.5, R * 2, R);
      ctx.restore();
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.9, R * 0.35, 0, 0, TAU);
      ctx.lineWidth = R * 0.055;
      ctx.strokeStyle = '#f07a12';
      ctx.stroke();
    },
  },

  banana: {
    rind: '#f2b705',
    flesh: '#fff1c9',
    juice: ['#ffe066', '#f7c948', '#fff7d6'],
    whole(ctx, R) {
      ctx.save();
      ctx.rotate(-0.18);
      ctx.beginPath();
      ctx.moveTo(-R * 0.82, -R * 0.5);
      ctx.bezierCurveTo(-R * 0.62, R * 0.85, R * 0.55, R * 0.92, R * 0.86, -R * 0.42);
      ctx.bezierCurveTo(R * 0.66, -R * 0.42, R * 0.6, R * 0.5, R * 0.06, R * 0.62);
      ctx.bezierCurveTo(-R * 0.5, R * 0.72, -R * 0.54, -R * 0.3, -R * 0.82, -R * 0.5);
      ctx.closePath();
      const g = ctx.createLinearGradient(-R * 0.4, -R * 0.7, R * 0.4, R * 0.8);
      g.addColorStop(0, '#ffe98a');
      g.addColorStop(0.45, '#ffd93d');
      g.addColorStop(1, '#d99a00');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = R * 0.045;
      ctx.strokeStyle = 'rgba(120,80,0,0.4)';
      ctx.stroke();

      // ridges
      ctx.save();
      ctx.globalAlpha = 0.35;
      for (const o of [0, 0.12, 0.24]) {
        ctx.beginPath();
        ctx.moveTo(-R * 0.76, -R * 0.44 + o * R);
        ctx.bezierCurveTo(-R * 0.5, R * 0.8 + o * R, R * 0.5, R * 0.86 + o * R, R * 0.8, -R * 0.38 + o * R);
        ctx.lineWidth = R * 0.035;
        ctx.strokeStyle = '#b57c00';
        ctx.stroke();
      }
      ctx.restore();

      // brown tips
      ctx.beginPath();
      ctx.ellipse(-R * 0.8, -R * 0.46, R * 0.1, R * 0.07, 0.6, 0, TAU);
      ctx.fillStyle = '#6b4318';
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(R * 0.84, -R * 0.4, R * 0.09, R * 0.06, -0.5, 0, TAU);
      ctx.fillStyle = '#6b4318';
      ctx.fill();

      // gloss
      ctx.beginPath();
      ctx.moveTo(-R * 0.58, R * 0.05);
      ctx.quadraticCurveTo(0, R * 0.5, R * 0.5, R * 0.1);
      ctx.lineWidth = R * 0.09;
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineCap = 'round';
      ctx.stroke();
      speckle(ctx, R * 0.7, 18, '#8a5a00', 0.012, 0.25, 0.7);
      ctx.restore();
    },
    flesh(ctx, R) {
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.72, R * 0.3, 0, 0, TAU);
      const g = ctx.createRadialGradient(0, -R * 0.05, R * 0.05, 0, 0, R * 0.75);
      g.addColorStop(0, '#fffdf0');
      g.addColorStop(1, '#f4dd9c');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = R * 0.05;
      ctx.strokeStyle = '#e0b53a';
      ctx.stroke();
      ctx.fillStyle = 'rgba(150,110,40,0.5)';
      for (let i = -3; i <= 3; i++) {
        ctx.beginPath();
        ctx.arc(i * R * 0.18, Math.sin(i) * R * 0.06, R * 0.025, 0, TAU);
        ctx.fill();
      }
    },
  },

  pineapple: {
    rind: '#c98a12',
    flesh: '#ffd34d',
    juice: ['#ffd84d', '#f2b705', '#8fd14f'],
    whole(ctx, R) {
      // crown
      ctx.save();
      for (let i = -3; i <= 3; i++) {
        const a = i * 0.3;
        ctx.save();
        ctx.translate(i * R * 0.06, -R * 0.72);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(-R * 0.12, R * 0.1);
        ctx.quadraticCurveTo(-R * 0.03, -R * 0.5, 0, -R * 0.72);
        ctx.quadraticCurveTo(R * 0.05, -R * 0.42, R * 0.12, R * 0.1);
        ctx.closePath();
        const lg = ctx.createLinearGradient(0, -R * 0.7, 0, R * 0.1);
        lg.addColorStop(0, '#bfe86a');
        lg.addColorStop(1, '#2f7a2c');
        ctx.fillStyle = lg;
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();

      // body
      ctx.beginPath();
      ctx.ellipse(0, R * 0.1, R * 0.78, R * 0.9, 0, 0, TAU);
      const g = ctx.createLinearGradient(-R * 0.6, -R * 0.6, R * 0.7, R * 0.8);
      g.addColorStop(0, '#ffe07a');
      g.addColorStop(0.4, '#f5b722');
      g.addColorStop(0.8, '#c07c0c');
      g.addColorStop(1, '#8a5505');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, R * 0.1, R * 0.78, R * 0.9, 0, 0, TAU);
      ctx.clip();
      // diamond crosshatch
      ctx.strokeStyle = 'rgba(120,70,0,0.5)';
      ctx.lineWidth = R * 0.035;
      const step = R * 0.26;
      for (let k = -8; k <= 8; k++) {
        ctx.beginPath();
        ctx.moveTo(-R + k * step, -R);
        ctx.lineTo(R + k * step, R);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(R - k * step, -R);
        ctx.lineTo(-R - k * step, R);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = '#7a4a02';
      for (let k = -8; k <= 8; k++) {
        ctx.beginPath();
        ctx.moveTo(-R + k * step, -R);
        ctx.lineTo(R + k * step, R);
        ctx.stroke();
      }
      ctx.restore();
      gloss(ctx, R * 0.95, 0.35);
    },
    flesh(ctx, R) {
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.78, R * 0.34, 0, 0, TAU);
      ctx.fillStyle = '#e0a91c';
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.68, R * 0.29, 0, 0, TAU);
      const g = ctx.createRadialGradient(0, -R * 0.05, R * 0.04, 0, 0, R * 0.7);
      g.addColorStop(0, '#ffeb9c');
      g.addColorStop(1, '#ffc93c');
      ctx.fillStyle = g;
      ctx.fill();
      // radial fibre lines
      ctx.strokeStyle = 'rgba(210,150,20,0.5)';
      ctx.lineWidth = R * 0.02;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * R * 0.16, Math.sin(a) * R * 0.07);
        ctx.lineTo(Math.cos(a) * R * 0.66, Math.sin(a) * R * 0.27);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.15, R * 0.07, 0, 0, TAU);
      ctx.fillStyle = '#f7d97a';
      ctx.fill();
    },
  },

  strawberry: {
    rind: '#c41230',
    flesh: '#ffd9dd',
    juice: ['#ff3b52', '#e01033', '#ffe1e4'],
    whole(ctx, R) {
      ctx.beginPath();
      ctx.moveTo(0, R * 1.02);
      ctx.bezierCurveTo(-R * 0.5, R * 0.62, -R * 0.94, R * 0.05, -R * 0.72, -R * 0.4);
      ctx.bezierCurveTo(-R * 0.56, -R * 0.76, R * 0.56, -R * 0.76, R * 0.72, -R * 0.4);
      ctx.bezierCurveTo(R * 0.94, R * 0.05, R * 0.5, R * 0.62, 0, R * 1.02);
      ctx.closePath();
      const g = ctx.createRadialGradient(-R * 0.3, -R * 0.32, R * 0.06, 0, R * 0.1, R * 1.15);
      g.addColorStop(0, '#ff8a86');
      g.addColorStop(0.35, '#f32b45');
      g.addColorStop(0.8, '#c00e2e');
      g.addColorStop(1, '#7d061c');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = R * 0.04;
      ctx.strokeStyle = 'rgba(90,0,20,0.3)';
      ctx.stroke();

      // seeds
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(0, R * 0.98);
      ctx.bezierCurveTo(-R * 0.48, R * 0.6, -R * 0.9, R * 0.05, -R * 0.68, -R * 0.38);
      ctx.bezierCurveTo(-R * 0.52, -R * 0.7, R * 0.52, -R * 0.7, R * 0.68, -R * 0.38);
      ctx.bezierCurveTo(R * 0.9, R * 0.05, R * 0.48, R * 0.6, 0, R * 0.98);
      ctx.clip();
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) {
          const x = (col - 2) * R * 0.28 + (row % 2 ? R * 0.1 : 0);
          const y = -R * 0.35 + row * R * 0.28;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(x * 1.2);
          ctx.beginPath();
          ctx.ellipse(0, 0, R * 0.028, R * 0.055, 0, 0, TAU);
          ctx.fillStyle = '#ffe9a8';
          ctx.fill();
          ctx.restore();
        }
      }
      ctx.restore();

      gloss(ctx, R, 0.45);

      // leafy crown
      ctx.save();
      ctx.translate(0, -R * 0.62);
      for (let i = -2; i <= 2; i++) {
        ctx.save();
        ctx.rotate(i * 0.42);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(-R * 0.12, -R * 0.28, 0, -R * 0.42);
        ctx.quadraticCurveTo(R * 0.12, -R * 0.28, 0, 0);
        ctx.fillStyle = i % 2 ? '#4d9e38' : '#67bd45';
        ctx.fill();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -R * 0.22);
      ctx.lineWidth = R * 0.07;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#3f7d2a';
      ctx.stroke();
      ctx.restore();
    },
    flesh(ctx, R) {
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.7, R * 0.3, 0, 0, TAU);
      const g = ctx.createRadialGradient(0, -R * 0.06, R * 0.05, 0, 0, R * 0.72);
      g.addColorStop(0, '#fff4f0');
      g.addColorStop(0.55, '#ffd9dd');
      g.addColorStop(1, '#ff9aa8');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = R * 0.045;
      ctx.strokeStyle = '#c41230';
      ctx.stroke();
      // pale core star
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.7, R * 0.3, 0, 0, TAU);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU;
        ctx.beginPath();
        ctx.ellipse(Math.cos(a) * R * 0.34, Math.sin(a) * R * 0.15, R * 0.1, R * 0.045, a, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    },
  },

  bomb: {
    rind: '#1a1c22',
    flesh: '#3a3f48',
    juice: ['#4a4f58', '#ffb03a', '#ff5a1f'],
    whole(ctx, R) {
      sphere(ctx, R, '#5c626d', '#23262e', '#08090c');
      // metallic band
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.99, 0, TAU);
      ctx.clip();
      const g = ctx.createLinearGradient(0, -R * 0.2, 0, R * 0.55);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(180,190,210,0.22)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-R, -R * 0.2, R * 2, R * 0.8);
      ctx.restore();
      // red warning glow
      const rg = ctx.createRadialGradient(0, R * 0.18, R * 0.1, 0, R * 0.22, R * 0.85);
      rg.addColorStop(0, 'rgba(255,60,40,0.35)');
      rg.addColorStop(1, 'rgba(255,60,40,0)');
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, TAU);
      ctx.fillStyle = rg;
      ctx.fill();
      gloss(ctx, R, 0.6);
      rim(ctx, R, 'rgba(0,0,0,0.5)');

      // brass collar
      ctx.beginPath();
      ctx.roundRect(-R * 0.2, -R * 1.02, R * 0.4, R * 0.22, R * 0.05);
      const cg = ctx.createLinearGradient(-R * 0.2, 0, R * 0.2, 0);
      cg.addColorStop(0, '#8a6531');
      cg.addColorStop(0.45, '#e8c07a');
      cg.addColorStop(1, '#7a5526');
      ctx.fillStyle = cg;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = R * 0.02;
      ctx.stroke();
    },
    flesh(ctx, R) {
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.8, R * 0.34, 0, 0, TAU);
      ctx.fillStyle = '#2a2d34';
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.7, R * 0.27, 0, 0, TAU);
      ctx.fillStyle = '#4a4f58';
      ctx.fill();
      ctx.fillStyle = 'rgba(255,180,80,0.85)';
      for (let i = 0; i < 5; i++) {
        const a = -0.9 + i * 0.42;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * R * 0.42, Math.sin(a) * R * 0.16, R * 0.035, 0, TAU);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.8, R * 0.34, 0, 0, TAU);
      ctx.lineWidth = R * 0.05;
      ctx.strokeStyle = '#111318';
      ctx.stroke();
    },
  },
};

/** Shared cut-face plate: a foreshortened ellipse with a rind rim. */
function fleshPlate(ctx, R, [colors, rimColor]) {
  ctx.beginPath();
  ctx.ellipse(0, 0, R * 0.94, R * 0.4, 0, 0, TAU);
  ctx.fillStyle = rimColor;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, 0, R * 0.87, R * 0.34, 0, 0, TAU);
  const g = ctx.createRadialGradient(0, -R * 0.1, R * 0.04, 0, 0, R * 0.9);
  g.addColorStop(0, colors[0]);
  g.addColorStop(0.6, colors[1]);
  g.addColorStop(1, colors[2]);
  ctx.fillStyle = g;
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Sprite baking
// ---------------------------------------------------------------------------

function bakeWhole(id, R) {
  const S = R * 2 * PAD;
  const size = Math.ceil(S * BAKE_SCALE);
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.scale(BAKE_SCALE, BAKE_SCALE);
  ctx.translate(S / 2, S / 2);
  FRUITS[id].whole(ctx, R);
  return { canvas: cv, size: S, radius: R };
}

/**
 * A half sprite: the whole fruit clipped to one side of the cut line, with the
 * cut face drawn so it reads as fruit flesh facing the camera.
 */
function bakeHalf(id, R, flip) {
  const spec = FRUITS[id];
  const S = R * 2 * PAD;
  const size = Math.ceil(S * BAKE_SCALE);
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.scale(BAKE_SCALE, BAKE_SCALE);
  ctx.translate(S / 2, S / 2);
  if (flip) ctx.rotate(Math.PI);

  ctx.save();
  // Keep the half that is above the cut line (y <= 0).
  ctx.beginPath();
  ctx.rect(-S / 2, -S / 2, S, S / 2);
  ctx.clip();
  spec.whole(ctx, R);
  ctx.restore();

  // Cut face sits on the line and reads as flesh.
  ctx.save();
  ctx.beginPath();
  ctx.rect(-S / 2, -S / 2, S, S / 2 + R * 0.02);
  ctx.clip();
  spec.flesh(ctx, R);
  ctx.restore();

  // Slight darkening of the cut lip for depth.
  ctx.save();
  ctx.beginPath();
  ctx.rect(-R, -R * 0.02, R * 2, R * 0.03);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fill();
  ctx.restore();

  return { canvas: cv, size: S, radius: R };
}

/** Lazily baked sprite store keyed by `id:mode`. */
export class SpriteCache {
  constructor() {
    this.cache = new Map();
  }
  get(id, mode, R) {
    const key = `${id}:${mode}:${Math.round(R)}`;
    let sprite = this.cache.get(key);
    if (!sprite) {
      if (mode === 'whole') sprite = bakeWhole(id, R);
      else sprite = bakeHalf(id, R, mode === 'b');
      this.cache.set(key, sprite);
    }
    return sprite;
  }
  /** Draw a sprite centered at the current transform origin. */
  draw(ctx, id, mode, R, alpha = 1) {
    const s = this.get(id, mode, R);
    if (alpha < 1) {
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = alpha;
      ctx.drawImage(s.canvas, -s.size / 2, -s.size / 2, s.size, s.size);
      ctx.globalAlpha = prev;
    } else {
      ctx.drawImage(s.canvas, -s.size / 2, -s.size / 2, s.size, s.size);
    }
  }
}

export const FRUIT_ART = FRUITS;

export function drawBombSpark(ctx, x, y, t, scale = 1) {
  const flicker = 0.65 + Math.sin(t * 22) * 0.18 + Math.sin(t * 37) * 0.1;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 26);
  g.addColorStop(0, `rgba(255,255,220,${0.95 * flicker})`);
  g.addColorStop(0.25, `rgba(255,190,70,${0.8 * flicker})`);
  g.addColorStop(0.6, `rgba(255,90,20,${0.28 * flicker})`);
  g.addColorStop(1, 'rgba(255,60,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, 26, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#fffbe0';
  ctx.beginPath();
  ctx.arc(0, 0, 3 + flicker * 2.4, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Static dojo backdrop, baked once. */
export function bakeBackground(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#120f22');
  bg.addColorStop(0.45, '#1c1530');
  bg.addColorStop(0.78, '#251a2c');
  bg.addColorStop(1, '#120c16');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Moon glow / shoji light behind the action.
  const moon = ctx.createRadialGradient(w * 0.5, h * 0.34, 10, w * 0.5, h * 0.36, w * 0.42);
  moon.addColorStop(0, 'rgba(255,196,120,0.30)');
  moon.addColorStop(0.35, 'rgba(255,140,90,0.10)');
  moon.addColorStop(1, 'rgba(255,120,80,0)');
  ctx.fillStyle = moon;
  ctx.fillRect(0, 0, w, h);

  // Shoji screen panel with grid.
  const sw = w * 0.56;
  const sh = h * 0.46;
  const sx = (w - sw) / 2;
  const sy = h * 0.1;
  ctx.save();
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = '#ffd9a0';
  ctx.beginPath();
  ctx.roundRect(sx, sy, sw, sh, 18);
  ctx.fill();
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = '#ffcf9a';
  ctx.lineWidth = 3;
  for (let i = 1; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(sx + (sw / 6) * i, sy);
    ctx.lineTo(sx + (sw / 6) * i, sy + sh);
    ctx.stroke();
  }
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(sx, sy + (sh / 4) * i);
    ctx.lineTo(sx + sw, sy + (sh / 4) * i);
    ctx.stroke();
  }
  ctx.lineWidth = 8;
  ctx.globalAlpha = 0.18;
  ctx.strokeRect(sx, sy, sw, sh);
  ctx.restore();

  // Distant mountain silhouettes.
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = '#0c0a16';
  ctx.beginPath();
  ctx.moveTo(0, h * 0.72);
  ctx.lineTo(w * 0.16, h * 0.5);
  ctx.lineTo(w * 0.3, h * 0.68);
  ctx.lineTo(w * 0.46, h * 0.44);
  ctx.lineTo(w * 0.62, h * 0.7);
  ctx.lineTo(w * 0.8, h * 0.48);
  ctx.lineTo(w, h * 0.66);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Bamboo on the edges.
  const bamboo = (x, alpha, scale) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, h);
    ctx.scale(scale, scale);
    for (let i = 0; i < 3; i++) {
      const bx = i * 26 - 20;
      const bh = 640 + i * 90;
      const g = ctx.createLinearGradient(bx, 0, bx + 20, 0);
      g.addColorStop(0, '#1d3a24');
      g.addColorStop(0.5, '#2f5c35');
      g.addColorStop(1, '#122617');
      ctx.fillStyle = g;
      ctx.fillRect(bx, -bh, 20, bh);
      ctx.fillStyle = 'rgba(10,20,12,0.9)';
      for (let k = 1; k < 7; k++) ctx.fillRect(bx, -bh + (bh / 7) * k, 20, 6);
      // leaves
      for (let k = 0; k < 5; k++) {
        ctx.save();
        ctx.translate(bx + 10, -bh + 40 + k * 70);
        ctx.rotate((k % 2 ? 1 : -1) * (0.6 + k * 0.08));
        ctx.beginPath();
        ctx.ellipse(40, 0, 48, 10, 0, 0, TAU);
        ctx.fillStyle = 'rgba(38,86,44,0.85)';
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.restore();
  };
  bamboo(-40, 0.55, 1.1);
  bamboo(w - 90, 0.5, 1.25);

  // Wooden floor.
  const floorY = h * 0.82;
  const floor = ctx.createLinearGradient(0, floorY, 0, h);
  floor.addColorStop(0, 'rgba(58,32,24,0.95)');
  floor.addColorStop(1, 'rgba(24,12,12,1)');
  ctx.fillStyle = floor;
  ctx.beginPath();
  ctx.moveTo(0, floorY);
  ctx.lineTo(w, floorY);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.strokeStyle = '#8b5a3c';
  ctx.lineWidth = 2;
  for (let i = 1; i < 18; i++) {
    const t = i / 18;
    ctx.beginPath();
    ctx.moveTo(w * 0.5 + (t - 0.5) * w * 0.2, floorY);
    ctx.lineTo(w * 0.5 + (t - 0.5) * w * 1.6, h);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(0, floorY);
  ctx.lineTo(w, floorY);
  ctx.stroke();
  ctx.restore();

  // Vignette.
  const vig = ctx.createRadialGradient(w / 2, h * 0.5, h * 0.35, w / 2, h * 0.5, h * 0.95);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(0.7, 'rgba(0,0,0,0.35)');
  vig.addColorStop(1, 'rgba(0,0,0,0.8)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  return cv;
}

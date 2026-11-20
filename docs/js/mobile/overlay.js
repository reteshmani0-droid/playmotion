/**
 * Phone camera viewfinder: mirrored video + hand skeleton + slice-power trail.
 * Drawing video and landmarks in one canvas guarantees they line up exactly.
 */
import { HAND_BONES, LM } from '../shared/protocol.js';
import { clamp } from '../shared/util.js';

export class Overlay {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLVideoElement} video
   */
  constructor(canvas, video) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.video = video;
    this.flip = true;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.trails = new Map();
    this.lastFrame = null;
    this.lastDraw = 0;
    this._ro = null;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  observe() {
    this.resize();
    if ('ResizeObserver' in window) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.canvas);
    } else {
      window.addEventListener('resize', () => this.resize());
    }
  }

  /** @param {{hands:Array, w:number, h:number, fps:number}|null} frame */
  draw(frame, now) {
    const ctx = this.ctx;
    const cw = this.w;
    const ch = this.h;
    if (!cw || !ch) return;
    this.lastFrame = frame;
    this.lastDraw = now;

    ctx.clearRect(0, 0, cw, ch);

    const video = this.video;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    const scale = Math.max(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;

    ctx.save();
    if (this.flip) {
      ctx.translate(cw, 0);
      ctx.scale(-1, 1);
    }

    // Video frame (or a stylised placeholder when the camera is unavailable).
    if (video.readyState >= 2) {
      try {
        ctx.drawImage(video, dx, dy, dw, dh);
      } catch {}
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, ch);
      g.addColorStop(0, '#1a1329');
      g.addColorStop(1, '#0a0713');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cw, ch);
    }

    // Dim the frame slightly so the neon skeleton pops.
    ctx.fillStyle = 'rgba(5, 4, 12, 0.18)';
    ctx.fillRect(0, 0, cw, ch);

    const hands = frame?.hands || [];
    const toScreen = (p) => [dx + p[0] * dw, dy + p[1] * dh];

    // Trails first (behind the skeleton).
    for (const h of hands) {
      const [px, py] = toScreen(h.palm);
      let tr = this.trails.get(h.hand);
      if (!tr) {
        tr = [];
        this.trails.set(h.hand, tr);
      }
      tr.push({ x: px, y: py, t: now, speed: h.speed });
      while (tr.length && now - tr[0].t > 170) tr.shift();
      if (tr.length > 1) {
        const hot = clamp((h.speed - 0.35) / 0.9, 0, 1);
        ctx.save();
        ctx.lineCap = 'round';
        for (let i = 1; i < tr.length; i++) {
          const a = i / tr.length;
          ctx.strokeStyle = `rgba(${Math.round(255 - hot * 60)},${Math.round(230 + hot * 25)},255,${a * (0.25 + hot * 0.55)})`;
          ctx.lineWidth = 2 + a * (6 + hot * 10);
          ctx.beginPath();
          ctx.moveTo(tr[i - 1].x, tr[i - 1].y);
          ctx.lineTo(tr[i].x, tr[i].y);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    // Drop trails for hands that vanished.
    for (const key of this.trails.keys()) {
      if (!hands.some((h) => h.hand === key)) this.trails.delete(key);
    }

    for (const h of hands) {
      const pts = (h.landmarks || []).map(toScreen);
      if (pts.length < 21) continue;
      const hot = clamp((h.speed - 0.3) / 1.0, 0, 1);
      const baseColor = h.hand === 'Left' ? '255, 226, 150' : '150, 240, 255';

      // dark outline pass then bright pass
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const [a, b] of HAND_BONES) {
        ctx.beginPath();
        ctx.moveTo(pts[a][0], pts[a][1]);
        ctx.lineTo(pts[b][0], pts[b][1]);
        ctx.strokeStyle = 'rgba(4, 8, 16, 0.55)';
        ctx.lineWidth = 7;
        ctx.stroke();
        ctx.strokeStyle = `rgba(${baseColor},${0.65 + hot * 0.35})`;
        ctx.lineWidth = 2.6;
        ctx.stroke();
      }
      for (let i = 0; i < pts.length; i++) {
        const big = i === LM.MIDDLE_MCP;
        ctx.beginPath();
        ctx.arc(pts[i][0], pts[i][1], big ? 5 : 2.4, 0, Math.PI * 2);
        ctx.fillStyle = big ? `rgba(255,255,255,${0.85})` : `rgba(${baseColor},0.9)`;
        ctx.fill();
      }

      // Palm halo + blade tip
      const palm = pts[LM.MIDDLE_MCP];
      const tip = pts[LM.INDEX_TIP];
      const pr = clamp(h.span * dw * 2.2, 26, 90);
      const glow = ctx.createRadialGradient(palm[0], palm[1], 0, palm[0], palm[1], pr);
      glow.addColorStop(0, `rgba(255,255,255,${0.22 + hot * 0.3})`);
      glow.addColorStop(0.5, `rgba(${baseColor},${0.16 + hot * 0.25})`);
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(palm[0], palm[1], pr, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(tip[0], tip[1], 13 + hot * 8, 0, Math.PI * 2);
      ctx.strokeStyle = hot > 0.45 ? 'rgba(255,215,106,0.95)' : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(tip[0], tip[1], 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();

    // Viewfinder corners + empty state are drawn in screen space.
    this._drawFrameChrome(ctx, cw, ch, hands.length > 0, frame);
  }

  _drawFrameChrome(ctx, cw, ch, hasHands, frame) {
    const m = 14;
    const len = 26;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    for (const [x, y, sx, sy] of [
      [m, m, 1, 1], [cw - m, m, -1, 1], [m, ch - m, 1, -1], [cw - m, ch - m, -1, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x + sx * len, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + sy * len);
      ctx.stroke();
    }

    if (!hasHands) {
      ctx.textAlign = 'center';
      ctx.font = '800 11px "SF Pro Display", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 246, 233, 0.7)';
      const msg = frame ? 'STEP INTO FRAME · SHOW YOUR HANDS' : 'CAMERA WARMING UP';
      ctx.fillText(msg, cw / 2, ch / 2 + 4);
      // pulsing target
      const t = (performance.now() % 1600) / 1600;
      ctx.strokeStyle = `rgba(255, 215, 106, ${0.55 - t * 0.4})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cw / 2, ch / 2 - 26, 16 + t * 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 215, 106, 0.85)';
      ctx.beginPath();
      ctx.arc(cw / 2, ch / 2 - 26, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

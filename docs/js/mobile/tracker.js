/**
 * Phone-side hand tracking.
 *
 * MediaPipe HandLandmarker runs locally on the phone (GPU delegate, CPU
 * fallback). We never send video for gameplay — only 2×21 smoothed landmark
 * pairs, ~600 bytes per frame at 30 Hz.
 */
import { FilesetResolver, HandLandmarker } from '../../vendor/mediapipe/vision_bundle.mjs';
import { LM, HAND_BONES } from '../shared/protocol.js';
import { OneEuro, clamp } from '../shared/util.js';

const WASM_PATH = new URL('../../vendor/mediapipe', import.meta.url).href;
const MODEL_PATH = new URL('../../vendor/mediapipe/hand_landmarker.task', import.meta.url).href;
const TARGET_FPS = 30;

// Canonical-ish hand shape used by the synthetic dev source and the overlay.
const HAND_SHAPE = [
  [0.0, 0.0], [-0.28, -0.1], [-0.4, -0.24], [-0.5, -0.38], [-0.58, -0.5],
  [-0.2, -0.62], [-0.22, -0.86], [-0.22, -1.0], [-0.22, -1.12],
  [0.0, -0.66], [0.0, -0.94], [0.0, -1.08], [0.0, -1.18],
  [0.2, -0.62], [0.2, -0.88], [0.2, -1.0], [0.2, -1.08],
  [0.38, -0.56], [0.4, -0.76], [0.4, -0.86], [0.4, -0.93],
];

export class HandTracker {
  /**
   * @param {{video:HTMLVideoElement, onFrame:(frame:any)=>void, onStatus:(s:any)=>void}} opts
   */
  constructor({ video, onFrame, onStatus }) {
    this.video = video;
    this.onFrame = onFrame;
    this.onStatus = onStatus;
    this.landmarker = null;
    this.running = false;
    this.facing = 'user';
    this.stream = null;
    this.fake = false;
    this.delegate = 'GPU';
    this.lastDetect = 0;
    this.lastTs = 0;
    this.fps = 0;
    this._emaFps = 0;
    this._filters = new Map(); // hand label -> {filters, lastSeen}
    this._prevPalm = new Map(); // hand label -> {x, y, t, speed}
    this._failures = 0;
    this._raf = 0;
    this._rvcId = 0;
    this._fakeTimer = 0;
    this._frameCount = 0;
    this._fpsWindowStart = 0;
    this._wakeLock = null;
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  async initModel() {
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    const options = (delegate) => ({
      baseOptions: {
        modelAssetPath: MODEL_PATH,
        delegate,
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'));
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('GPU delegate failed, falling back to CPU', err);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
      this.delegate = 'CPU';
    }
  }

  async openCamera(facing = this.facing) {
    if (!navigator.mediaDevices?.getUserMedia) {
      const err = new Error('getUserMedia-unavailable');
      err.name = 'NotSupportedError';
      throw err;
    }
    this.stopStream();
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: TARGET_FPS, max: 60 },
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.stream = stream;
    this.facing = facing;
    this.video.srcObject = stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play().catch(() => {});
    // Wait until we have real dimensions before handing frames to MediaPipe.
    await new Promise((resolve) => {
      if (this.video.videoWidth) return resolve();
      const onLoaded = () => {
        this.video.removeEventListener('loadedmetadata', onLoaded);
        resolve();
      };
      this.video.addEventListener('loadedmetadata', onLoaded);
      setTimeout(onLoaded, 2500);
    });
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() || {};
    this.cameraInfo = {
      width: settings.width || this.video.videoWidth,
      height: settings.height || this.video.videoHeight,
      facing: settings.facingMode || facing,
      label: track?.label || '',
    };
    return this.cameraInfo;
  }

  stopStream() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
  }

  async switchCamera() {
    const next = this.facing === 'user' ? 'environment' : 'user';
    await this.openCamera(next);
    this.onStatus?.({ camera: true, cameraInfo: this.cameraInfo, facing: next });
    return next;
  }

  // -------------------------------------------------------------------------
  // Tracking loop
  // -------------------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this._failures = 0;
    this._fpsWindowStart = performance.now();
    this._frameCount = 0;
    this._schedule();
  }

  stop() {
    this.running = false;
    if (this._rvcId && this.video.cancelVideoFrameCallback) {
      try {
        this.video.cancelVideoFrameCallback(this._rvcId);
      } catch {}
      this._rvcId = 0;
    }
    cancelAnimationFrame(this._raf);
    clearInterval(this._fakeTimer);
  }

  _schedule() {
    if (!this.running) return;
    if (this.video.requestVideoFrameCallback) {
      this._rvcId = this.video.requestVideoFrameCallback(() => {
        if (!this.running) return;
        this._tick();
        this._schedule();
      });
    } else {
      this._raf = requestAnimationFrame(() => {
        if (!this.running) return;
        this._tick();
        this._schedule();
      });
    }
  }

  _tick() {
    const now = performance.now();
    if (now - this.lastDetect < 1000 / TARGET_FPS - 2) return;
    this.lastDetect = now;
    if (!this.landmarker || this.video.readyState < 2 || !this.video.videoWidth) return;

    let result;
    try {
      this.lastTs = Math.max(now, this.lastTs + 1);
      result = this.landmarker.detectForVideo(this.video, this.lastTs);
      this._failures = 0;
    } catch (err) {
      this._failures++;
      if (this._failures === 8) {
        this.onStatus?.({ camera: true, tracking: 'error', error: err?.message || 'tracking failed' });
      }
      return;
    }
    this._consume(result, now, this.video.videoWidth, this.video.videoHeight);
  }

  _consume(result, now, w, h) {
    this._frameCount++;
    if (now - this._fpsWindowStart >= 700) {
      const fps = (this._frameCount * 1000) / (now - this._fpsWindowStart);
      this.fps = Math.round(fps);
      this._frameCount = 0;
      this._fpsWindowStart = now;
    }

    const dt = (now - (this._lastConsumeAt || now - 33)) / 1000;
    this._lastConsumeAt = now;

    /** @type {Array} */
    const hands = [];
    const landmarks = result?.landmarks || [];
    const handed = result?.handedness || [];

    for (let i = 0; i < landmarks.length; i++) {
      const lm = landmarks[i];
      if (!lm || lm.length < 21) continue;
      const cat = handed[i]?.[0];
      const rawLabel = cat?.categoryName === 'Left' || cat?.categoryName === 'Right' ? cat.categoryName : `H${i}`;
      const score = cat?.score ?? 0.9;
      let entry = this._filters.get(rawLabel);
      if (!entry) {
        entry = {
          filters: lm.map(() => ({
            x: new OneEuro({ minCutoff: 2.2, beta: 0.05, dCutoff: 1.2 }),
            y: new OneEuro({ minCutoff: 2.2, beta: 0.05, dCutoff: 1.2 }),
          })),
          lastSeen: now,
          lastPalm: null,
          speed: 0,
        };
        this._filters.set(rawLabel, entry);
      }

      const pts = new Array(21);
      let palmX = 0;
      let palmY = 0;
      for (let p = 0; p < 21; p++) {
        const fx = entry.filters[p].x.filter(lm[p].x, now);
        const fy = entry.filters[p].y.filter(lm[p].y, now);
        pts[p] = [fx, fy];
      }
      // Palm = middle MCP, which is steadier than the wrist or fingertips.
      palmX = pts[LM.MIDDLE_MCP][0];
      palmY = pts[LM.MIDDLE_MCP][1];

      // If tracking re-acquires somewhere far away, restart the filters so we
      // do not draw a slash across the whole screen.
      if (entry.lastPalm) {
        const jump = Math.hypot(palmX - entry.lastPalm[0], palmY - entry.lastPalm[1]);
        if (jump > 0.45) {
          for (const f of entry.filters) {
            f.x.reset(palmX);
            f.y.reset(palmY);
          }
          entry.lastPalm = [palmX, palmY];
          entry.speed = 0;
        }
      }

      const prev = entry.lastPalm;
      if (prev && dt > 0.001) {
        const inst = Math.hypot(palmX - prev[0], palmY - prev[1]) / dt;
        entry.speed = entry.speed * 0.45 + inst * 0.55;
      }
      entry.lastPalm = [palmX, palmY];
      entry.lastSeen = now;

      const wrist = pts[LM.WRIST];
      const span = Math.hypot(pts[LM.MIDDLE_MCP][0] - wrist[0], pts[LM.MIDDLE_MCP][1] - wrist[1]) * 2.6;
      const tip = pts[LM.INDEX_TIP];

      hands.push({
        hand: rawLabel,
        score,
        palm: [palmX, palmY],
        tip,
        span: clamp(span, 0.04, 0.5),
        speed: entry.speed,
        pts: pts.flat(),
        landmarks: pts,
      });
    }

    // Drop stale filters (hand left the frame).
    for (const [key, entry] of this._filters) {
      if (now - entry.lastSeen > 1200) this._filters.delete(key);
    }

    const frame = { hands, fps: this.fps, w, h, ts: now, delegate: this.delegate };
    this.onFrame?.(frame);
  }

  // -------------------------------------------------------------------------
  // Synthetic source (dev/testing without a camera)
  // -------------------------------------------------------------------------

  startFake() {
    this.fake = true;
    this.running = true;
    this.fps = 30;
    const t0 = performance.now();
    const makeHand = (label, cx, cy, scale, phase) => {
      const pts = HAND_SHAPE.map(([x, y], i) => {
        const wobble = Math.sin(t0 / 260 + phase + i * 0.3) * 0.006;
        return [cx + x * scale + wobble, cy + y * scale];
      });
      const palm = pts[LM.MIDDLE_MCP];
      return {
        hand: label,
        score: 0.99,
        palm,
        tip: pts[LM.INDEX_TIP],
        span: scale * 1.1,
        speed: 1.2,
        pts: pts.flat(),
        landmarks: pts,
      };
    };
    this._fakeTimer = setInterval(() => {
      if (!this.running) return;
      const t = (performance.now() - t0) / 1000;
      const a = makeHand('Left', 0.5 + Math.cos(t * 0.9) * 0.26, 0.52 + Math.sin(t * 1.7) * 0.2, 0.13, 0);
      const b = makeHand('Right', 0.5 + Math.cos(t * 0.9 + Math.PI) * 0.26, 0.52 + Math.sin(t * 1.7 + Math.PI) * 0.2, 0.13, 2);
      this.onFrame?.({ hands: [a, b], fps: 30, w: 640, h: 480, ts: performance.now(), delegate: 'FAKE' });
    }, 1000 / 30);
  }
}

export { HAND_BONES, HAND_SHAPE };

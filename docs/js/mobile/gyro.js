/**
 * Gyroscope-based controller.
 *
 * Turns the phone into a bat: tilt steers the bat, a swing (rapid rotation)
 * triggers a hit. Produces the same frame shape as HandTracker so the TV
 * needs no special-casing.
 */
export class GyroController {
  constructor({ onFrame, onStatus }) {
    this.onFrame = onFrame;
    this.onStatus = onStatus;
    this.running = false;
    this.fps = 30;
    this._raf = 0;
    this._last = 0;
    this._alpha = 0; this._beta = 45; this._gamma = 0;
    this._rate = { alpha: 0, beta: 0, gamma: 0 };
    this._swingCooldown = 0;
    this._swingPower = 0;
    this._swingActive = false;
    this._swingTimer = 0;
    this._neutralBeta = 45;
    this._neutralGamma = 0;
    this._calibrated = false;
    this._frameCount = 0;
    this._fpsStart = 0;
  }

  async requestPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== 'granted') throw new Error('orientation-permission-denied');
    }
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try { await DeviceMotionEvent.requestPermission(); } catch {}
    }
    return true;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._fpsStart = performance.now();
    this._frameCount = 0;
    this._last = performance.now();
    window.addEventListener('deviceorientation', this._onOrient, true);
    window.addEventListener('devicemotion', this._onMotion, true);
    this._loop();
    this.onStatus?.({ tracking: 'ok' });
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('deviceorientation', this._onOrient, true);
    window.removeEventListener('devicemotion', this._onMotion, true);
  }

  calibrate() {
    this._neutralBeta = this._beta;
    this._neutralGamma = this._gamma;
    this._calibrated = true;
  }

  _onOrient = (e) => {
    if (e.alpha != null) this._alpha = e.alpha;
    if (e.beta != null) this._beta = e.beta;
    if (e.gamma != null) this._gamma = e.gamma;
  };

  _onMotion = (e) => {
    const r = e.rotationRate;
    if (r) {
      this._rate.alpha = r.alpha || 0;
      this._rate.beta = r.beta || 0;
      this._rate.gamma = r.gamma || 0;
    }
  };

  _loop = () => {
    if (!this.running) return;
    const now = performance.now();
    if (now - this._last < 1000 / this.fps - 2) {
      this._raf = requestAnimationFrame(this._loop);
      return;
    }
    this._last = now;

    // swing cooldown
    if (this._swingCooldown > 0) this._swingCooldown -= (now - this._last) / 1000 || 0.033;
    if (this._swingActive) {
      this._swingTimer += 0.033;
      if (this._swingTimer > 0.4) { this._swingActive = false; this._swingTimer = 0; }
    }

    // detect swing: rapid rotation
    const rateMag = Math.sqrt(this._rate.alpha ** 2 + this._rate.beta ** 2 + this._rate.gamma ** 2);
    if (rateMag > 180 && this._swingCooldown <= 0) {
      this._swingActive = true;
      this._swingTimer = 0;
      this._swingPower = clamp(rateMag / 400, 0.4, 1.5);
      this._swingCooldown = 0.6;
    }

    // map tilt to virtual hand position
    const betaRel = (this._beta - this._neutralBeta) / 60; // -1..1
    const gammaRel = (this._gamma - this._neutralGamma) / 45;
    const x = clamp(0.5 + gammaRel * 0.35, 0.05, 0.95);
    const y = clamp(0.45 + betaRel * 0.25, 0.1, 0.9);

    // speed: high during swing
    const speed = this._swingActive ? 1.5 + this._swingPower : 0.15;

    const hand = {
      hand: 'Right',
      score: 0.95,
      palm: [x, y],
      tip: [x + 0.02, y - 0.05],
      span: 0.12,
      speed,
      pts: [],
    };
    // fill pts with palm repeated (not used for gyro)
    for (let i = 0; i < 21; i++) { hand.pts.push(x, y); }

    this._frameCount++;
    if (now - this._fpsStart >= 700) {
      this.fps = Math.round((this._frameCount * 1000) / (now - this._fpsStart));
      this._frameCount = 0;
      this._fpsStart = now;
    }

    this.onFrame?.({ hands: [hand], fps: this.fps, w: 640, h: 480, ts: now, delegate: 'GYRO' });

    this._raf = requestAnimationFrame(this._loop);
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

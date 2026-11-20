/**
 * Nintendo Switch / Joy-Con controller support for PlayMotion.
 *
 * Works three ways:
 *   1. Gamepad API — Pro Controller, a single Joy-Con, or a pair of Joy-Cons
 *      paired over Bluetooth. Stick aims the bat, a button swings/bowls.
 *   2. WebHID gyro (Chrome/Edge) — reads the Joy-Con IMU directly so you can
 *      physically swing the controller. Needs a user click + calibration.
 *   3. Both at once — stick aims, gyro triggers the swing.
 *
 * Joy-Cons are special: L and R show up as *two separate gamepads*. This module
 * detects them by USB/BT product ID and merges them into one logical bat.
 */

const NINTENDO_VENDOR = 0x057e;
const JOYCON_L = 0x2006;
const JOYCON_R = 0x2007;
const PRO_CONTROLLER = 0x2009;

// Standard-gamepad button indexes that feel natural for a bat swing.
const SWING_BUTTONS = [0, 5, 7, 9];       // A, R, ZR, + (Pro / Joy-Con R)
const SWING_BUTTONS_LEFT = [4, 6, 8];     // L, ZL, - (Joy-Con L)

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function identifyPad(pad) {
  const id = (pad?.id || '').toLowerCase();
  const v = id.match(/vendor:\s*([0-9a-f]{4})/i);
  const p = id.match(/product:\s*([0-9a-f]{4})/i);
  const vendor = v ? parseInt(v[1], 16) : 0;
  const product = p ? parseInt(p[1], 16) : 0;
  if (vendor === NINTENDO_VENDOR || /joy-con|nintendo|switch/.test(id)) {
    if (product === JOYCON_L || /joy-con\s*\(l\)|joycon.?l/.test(id)) return { kind: 'joycon-l', vendor, product };
    if (product === JOYCON_R || /joy-con\s*\(r\)|joycon.?r/.test(id)) return { kind: 'joycon-r', vendor, product };
    if (product === PRO_CONTROLLER || /pro controller/.test(id)) return { kind: 'pro', vendor, product };
    return { kind: 'nintendo', vendor, product };
  }
  return { kind: 'gamepad', vendor, product };
}

export class SwitchController {
  constructor() {
    this.connected = false;
    this.controllerType = 'none';       // 'pro' | 'pair' | 'joycon-l' | 'joycon-r' | 'gamepad' | 'none'
    this.deviceNames = [];
    this.padMode = 'auto';              // 'auto' | 'pro' | 'pair' | 'single'
    this.aimX = 0;
    this.aimY = 0;
    this.swingPressed = false;          // true only on the frame a swing starts
    this.lastSwingPower = 0;

    this.gyroSupported = typeof navigator !== 'undefined' && !!navigator.hid;
    this.gyroEnabled = false;
    this.gyroCalibrated = false;
    this.gyro = { x: 0, y: 0, z: 0 };   // averaged normalized gyro (deg/s)

    this._swingCallbacks = [];
    this._statusCallbacks = [];
    this._prevButton = false;
    this._prevGyroSwing = false;
    this._hidDevices = [];
    this._gyroDevices = [];             // { device, name, neutral, armed }
    this._gyroThreshold = 650;          // deg/s above neutral that counts as a swing

    if (typeof window !== 'undefined') {
      window.addEventListener('gamepadconnected', () => this._emitStatus());
      window.addEventListener('gamepaddisconnected', () => this._emitStatus());
    }
  }

  onSwing(cb) { this._swingCallbacks.push(cb); }
  onStatus(cb) { this._statusCallbacks.push(cb); cb(this.status); }

  get status() {
    return {
      connected: this.connected,
      controllerType: this.controllerType,
      deviceNames: this.deviceNames.slice(),
      gyroEnabled: this.gyroEnabled,
      gyroCalibrated: this.gyroCalibrated,
      gyroSupported: this.gyroSupported,
      padMode: this.padMode,
      lastSwingPower: this.lastSwingPower,
    };
  }

  _emitStatus() {
    const s = this.status;
    this._statusCallbacks.forEach((cb) => { try { cb(s); } catch {} });
  }

  _emitSwing(power = 1) {
    this.lastSwingPower = power;
    this._swingCallbacks.forEach((cb) => {
      try { cb(power); } catch (e) { console.warn('[switch] swing callback failed', e); }
    });
  }

  setPadMode(mode) {
    this.padMode = mode;
    this._prevButton = false;
    this._emitStatus();
  }

  /** Call once per animation frame. */
  poll() {
    const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    const live = pads.filter((p) => p && p.connected);
    const identified = live.map((p) => ({ pad: p, info: identifyPad(p) }));

    // Pick the gamepad(s) to use based on the requested mode.
    let chosen = [];
    if (this.padMode === 'pair') {
      chosen = identified.filter((x) => x.info.kind === 'joycon-l' || x.info.kind === 'joycon-r');
      if (!chosen.length) chosen = identified.slice(0, 2);
    } else if (this.padMode === 'pro') {
      chosen = identified.filter((x) => x.info.kind === 'pro' || x.info.kind === 'nintendo');
      if (!chosen.length) chosen = identified.slice(0, 1);
    } else if (this.padMode === 'single') {
      chosen = identified.slice(0, 1);
    } else {
      // auto: prefer a Pro, else both Joy-Cons, else first pad.
      const pro = identified.filter((x) => x.info.kind === 'pro' || x.info.kind === 'nintendo');
      const joycons = identified.filter((x) => x.info.kind === 'joycon-l' || x.info.kind === 'joycon-r');
      if (pro.length) chosen = pro.slice(0, 1);
      else if (joycons.length) chosen = joycons.slice(0, 2);
      else chosen = identified.slice(0, 1);
    }

    const wasConnected = this.connected;
    const wasType = this.controllerType;
    this.connected = chosen.length > 0;
    this.deviceNames = chosen.map((x) => x.pad.id || 'Gamepad');

    const kinds = new Set(chosen.map((x) => x.info.kind));
    this.controllerType = !chosen.length ? 'none'
      : (kinds.has('joycon-l') && kinds.has('joycon-r')) ? 'pair'
      : kinds.has('joycon-l') ? 'joycon-l'
      : kinds.has('joycon-r') ? 'joycon-r'
      : kinds.has('pro') || kinds.has('nintendo') ? 'pro'
      : 'gamepad';

    this.swingPressed = false;
    if (!this.connected) {
      this.aimX = 0; this.aimY = 0;
      this._prevButton = false;
    } else {
      if (!wasConnected || wasType !== this.controllerType) {
        console.info('[switch] controller:', this.controllerType, this.deviceNames);
        this._emitStatus();
      }

      // --- aim: right stick, then left stick, then gyro tilt -------------
      let ax = 0, ay = 0, found = false;
      for (const { pad } of chosen) {
        const rx = pad.axes[2] ?? 0, ry = pad.axes[3] ?? 0;
        if (Math.hypot(rx, ry) > 0.18) { ax = rx; ay = ry; found = true; break; }
      }
      if (!found) {
        for (const { pad } of chosen) {
          const lx = pad.axes[0] ?? 0, ly = pad.axes[1] ?? 0;
          if (Math.hypot(lx, ly) > 0.18) { ax = lx; ay = ly; found = true; break; }
        }
      }
      const mag = Math.hypot(ax, ay);
      if (mag > 0.18) {
        const scale = (mag - 0.18) / (1 - 0.18) / mag;
        ax *= scale; ay *= scale;
        this.aimX = ax * 1.6;
        this.aimY = -ay * 1.0;
      } else if (this.gyroEnabled && this.gyroCalibrated) {
        // Gyro tilt steering: yaw (y) -> left/right, pitch (x) -> up/down.
        this.aimX = clamp(this.gyro.y / 55, -1.6, 1.6);
        this.aimY = clamp(-this.gyro.x / 55, -1, 1);
      } else {
        this.aimX = 0; this.aimY = 0;
      }

      // --- swing: any swing button on any chosen pad ---------------------
      const btn = chosen.some(({ pad, info }) => {
        const indexes = info.kind === 'joycon-l' ? SWING_BUTTONS_LEFT : SWING_BUTTONS;
        return indexes.some((i) => pad.buttons[i]?.pressed);
      });
      this.swingPressed = btn && !this._prevButton;
      if (this.swingPressed) this._emitSwing(0.9);
      this._prevButton = btn;
    }

    return this;
  }

  /**
   * Enable Joy-Con IMU over WebHID. The browser lets you select several
   * Nintendo devices at once, so pick both Joy-Cons if you have them.
   */
  async enableGyro() {
    if (!this.gyroSupported) {
      return { ok: false, reason: 'WebHID is not available. Use Chrome/Edge on desktop, or just swing with A / ZR.' };
    }
    try {
      const devices = await navigator.hid.requestDevice({
        filters: [{ vendorId: NINTENDO_VENDOR }],
      });
      if (!devices || !devices.length) {
        return { ok: false, reason: 'No Nintendo controller selected.' };
      }
      const names = [];
      for (const dev of devices.slice(0, 2)) {
        if (!dev.opened) await dev.open();
        // 0x03 = set input report mode -> 0x30 (standard full, includes IMU)
        // 0x40 = enable IMU
        const setMode = new Uint8Array([0x01, 0x03, 0x30]);
        const enableImu = new Uint8Array([0x01, 0x40, 0x01]);
        try { await dev.sendReport(0x01, setMode); } catch (e) { console.warn('[switch] setMode failed', e); }
        try { await dev.sendReport(0x01, enableImu); } catch (e) { console.warn('[switch] enableImu failed', e); }
        const name = dev.productName || `Joy-Con ${this._hidDevices.length + 1}`;
        dev.addEventListener('inputreport', (e) => this._parseHID(e));
        this._hidDevices.push(dev);
        this._gyroDevices.push({ name, gx: 0, gy: 0, gz: 0, neutral: null, armed: true });
        names.push(name);
      }
      this.gyroEnabled = true;
      this.gyroCalibrated = false;
      this._emitStatus();
      return { ok: true, reason: `Gyro on (${names.join(' + ')}). Hold still and calibrate, then swing!` };
    } catch (e) {
      console.warn('[switch] WebHID failed', e);
      return { ok: false, reason: e?.message || 'Could not open the controller.' };
    }
  }

  /** Capture the current orientation as neutral. Do this while holding still. */
  calibrate() {
    if (!this.gyroEnabled || !this._gyroDevices.length) {
      return { ok: false, reason: 'Enable gyro first.' };
    }
    for (const d of this._gyroDevices) {
      d.neutral = { x: d.gx, y: d.gy, z: d.gz };
      d.armed = true;
    }
    this.gyroCalibrated = true;
    this._emitStatus();
    return { ok: true, reason: 'Gyro calibrated. Swing the Joy-Con like a bat!' };
  }

  _parseHID(e) {
    const data = e.data;
    if (!data || data.byteLength < 20) return;
    const idx = this._hidDevices.indexOf(e.device);
    if (idx < 0) return;
    const d = this._gyroDevices[idx];
    if (!d) return;
    try {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      // 0x30 report: IMU samples start at byte 13, three int16 LE per axis.
      d.gx = dv.getInt16(13, true);
      d.gy = dv.getInt16(15, true);
      d.gz = dv.getInt16(17, true);

      // Average across devices so a pair feels like one bat.
      let sx = 0, sy = 0, sz = 0;
      for (const g of this._gyroDevices) { sx += g.gx; sy += g.gy; sz += g.gz; }
      const n = this._gyroDevices.length;
      this.gyro = { x: sx / n, y: sy / n, z: sz / n };

      if (!this.gyroCalibrated) return;
      for (const g of this._gyroDevices) {
        if (!g.neutral) continue;
        const dev = Math.hypot(g.gx - g.neutral.x, g.gy - g.neutral.y, g.gz - g.neutral.z);
        if (dev > this._gyroThreshold && g.armed) {
          g.armed = false;
          this.swingPressed = true;
          this._emitSwing(clamp(dev / 1600, 0.4, 1.5));
        } else if (dev < 300) {
          g.armed = true;
        }
      }
    } catch { /* ignore malformed report */ }
  }
}

// Shared singleton so the setup wizard and the games talk to the same controller.
export const switchController = new SwitchController();

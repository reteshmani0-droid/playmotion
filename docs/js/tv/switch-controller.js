/**
 * Nintendo Switch controller support for PlayMotion.
 *
 * Switch Pro Controllers and Joy-Cons (paired over Bluetooth) appear to the
 * browser as standard Gamepads. That gives us a reliable path:
 *   - stick  -> aim the bat
 *   - button -> swing / bowl
 *
 * Joy-Con gyro motion is NOT exposed through the Gamepad API. On Chrome/Edge we
 * can optionally read it through WebHID (experimental, needs a user click).
 * The button-based swing always works as a fallback.
 */

const SWING_BUTTONS = [0, 5, 7, 9]; // A, R, ZR, Start — any of these swings

export class SwitchController {
  constructor() {
    this.connected = false;
    this.padName = '';
    this.aimX = 0;
    this.aimY = 0;
    this.swingPressed = false;   // true on the frame a swing starts
    this._swingCallbacks = [];
    this._prevButton = false;
    this._prevGyroSwing = false;
    this._hidDevice = null;
    this._gyro = { x: 0, y: 0, z: 0 };
    this.gyroEnabled = false;
    this.gyroSupported = typeof navigator !== 'undefined' && !!navigator.hid;
  }

  onSwing(cb) { this._swingCallbacks.push(cb); }

  _emitSwing() {
    this._swingCallbacks.forEach((cb) => {
      try { cb(); } catch (e) { console.warn('switch swing callback failed', e); }
    });
  }

  /** Call once per animation frame. */
  poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) {
      if (p && p.connected) { pad = p; break; }
    }

    const wasConnected = this.connected;
    this.connected = !!pad;
    this.padName = pad ? (pad.id || 'Gamepad') : '';

    if (!pad) {
      this.aimX = 0; this.aimY = 0;
      this.swingPressed = false;
      this._prevButton = false;
      this._prevGyroSwing = false;
      return this;
    }

    if (!wasConnected) {
      console.info('[switch] controller connected:', this.padName);
    }

    // Prefer right stick (axes 2,3); fall back to left stick (axes 0,1).
    let ax = pad.axes[2] ?? 0;
    let ay = pad.axes[3] ?? 0;
    if (Math.abs(ax) < 0.15 && Math.abs(ay) < 0.15) {
      ax = pad.axes[0] ?? 0;
      ay = pad.axes[1] ?? 0;
    }
    // Deadzone + normalize so small drift is ignored.
    const mag = Math.hypot(ax, ay);
    if (mag > 0.18) {
      const scale = (mag - 0.18) / (1 - 0.18) / mag;
      ax *= scale; ay *= scale;
    } else { ax = 0; ay = 0; }

    this.aimX = ax * 1.6;
    this.aimY = -ay * 1.0;

    // Button swing (edge-triggered).
    const btn = SWING_BUTTONS.some((i) => pad.buttons[i]?.pressed) || false;
    this.swingPressed = btn && !this._prevButton;
    if (this.swingPressed) this._emitSwing();
    this._prevButton = btn;

    return this;
  }

  /** Best-effort Joy-Con gyro over WebHID (Chrome/Edge, user gesture required). */
  async enableGyro() {
    if (!this.gyroSupported) return { ok: false, reason: 'WebHID is not available in this browser. Use Chrome or Edge, or just use A/ZR to swing.' };
    try {
      const devices = await navigator.hid.requestDevice({
        filters: [{ vendorId: 0x057e }], // Nintendo
      });
      if (!devices || !devices.length) {
        return { ok: false, reason: 'No Nintendo controller selected.' };
      }
      const dev = devices[0];
      await dev.open();
      this._hidDevice = dev;

      // Tell the Joy-Con to use 0x30 (standard full) input reports, then enable IMU.
      const setMode = new Uint8Array([0x01, 0x03, 0x30]);
      const enableImu = new Uint8Array([0x01, 0x40, 0x01]);
      try { await dev.sendReport(0x01, setMode); } catch (e) { console.warn('[switch] setMode failed', e); }
      try { await dev.sendReport(0x01, enableImu); } catch (e) { console.warn('[switch] enableImu failed', e); }

      dev.addEventListener('inputreport', (e) => this._parseHID(e));
      this.gyroEnabled = true;
      return { ok: true, reason: 'Gyro enabled. Swing the controller to hit!' };
    } catch (e) {
      console.warn('[switch] WebHID failed', e);
      return { ok: false, reason: e?.message || 'Could not open the controller.' };
    }
  }

  _parseHID(e) {
    const data = e.data;
    if (!data || data.byteLength < 20) return;
    try {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      // IMU samples in 0x30 reports start around byte 13 (3 x int16, little-endian).
      const gx = dv.getInt16(13, true);
      const gy = dv.getInt16(15, true);
      const gz = dv.getInt16(17, true);
      this._gyro = { x: gx, y: gy, z: gz };

      const mag = Math.hypot(gx, gy, gz);
      if (mag > 900 && !this._prevGyroSwing) {
        this._prevGyroSwing = true;
        this.swingPressed = true;
        this._emitSwing();
      } else if (mag < 300) {
        this._prevGyroSwing = false;
      }
    } catch { /* malformed report — ignore */ }
  }

  get gyro() { return this._gyro; }
}

// Shared singleton so settings and games talk to the same controller.
export const switchController = new SwitchController();

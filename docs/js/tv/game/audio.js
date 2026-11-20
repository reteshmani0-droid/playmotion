/**
 * Fully procedural audio: a taiko/koto flavoured music loop and all the
 * slice/splat/bomb SFX are synthesised with Web Audio. No audio files, so the
 * game starts instantly and works offline on a TV.
 */

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

// D minor pentatonic across three octaves.
const SCALE = [50, 53, 55, 57, 60, 62, 65, 67, 69, 72, 74, 77, 79];

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.musicVolume = 0.34;
    this.sfxVolume = 0.75;
    this.musicOn = true;
    this.intensity = 0;
    this._musicTimer = 0;
    this._step = 0;
    this._nextTime = 0;
    this._bar = 0;
    this._noise = null;
    this._reverb = null;
    this._playing = false;
    this._ducked = false;
  }

  get supported() {
    return typeof window !== 'undefined' && Boolean(window.AudioContext || window.webkitAudioContext);
  }

  /** Must be called from a user gesture (click / keypress / gamepad button). */
  async unlock() {
    if (!this.supported) return false;
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this._buildGraph();
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {}
    }
    this.ready = this.ctx.state === 'running';
    return this.ready;
  }

  _buildGraph() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -16;
    this.compressor.knee.value = 22;
    this.compressor.ratio.value = 3.2;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.22;

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVolume;
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxVolume;

    this.musicBus.connect(this.compressor);
    this.sfxBus.connect(this.compressor);
    this.compressor.connect(this.master);
    this.master.connect(ctx.destination);

    // Reverb send.
    this._reverb = ctx.createConvolver();
    this._reverb.buffer = this._makeImpulse(2.4, 3.0);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.22;
    this.reverbSend.connect(this._reverb);
    this._reverb.connect(this.compressor);

    // Shared noise buffer.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noise = buf;
  }

  _makeImpulse(seconds, decay) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (1 - t * 0.2);
      }
    }
    return buf;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(muted ? 0 : 0.9, this.ctx.currentTime + 0.08);
    }
  }

  setMusicVolume(v) {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(this.musicVolume, this.ctx.currentTime, 0.05);
  }

  setSfxVolume(v) {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.sfxBus) this.sfxBus.gain.setTargetAtTime(this.sfxVolume, this.ctx.currentTime, 0.05);
  }

  duck(on) {
    if (!this.ctx) return;
    this._ducked = on;
    const target = this.musicVolume * (on ? 0.35 : 1);
    this.musicBus.gain.setTargetAtTime(target, this.ctx.currentTime, 0.12);
  }

  // -------------------------------------------------------------------------
  // Music
  // -------------------------------------------------------------------------

  startMusic() {
    if (!this.ready || !this.musicOn) return;
    if (this._playing) return;
    this._playing = true;
    this._step = 0;
    this._bar = 0;
    this._nextTime = this.ctx.currentTime + 0.08;
    this._musicTimer = setInterval(() => this._schedule(), 90);
    this._schedule();
  }

  stopMusic(fade = 0.4) {
    this._playing = false;
    clearInterval(this._musicTimer);
    this._musicTimer = 0;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setTargetAtTime(0, t, fade / 3);
    // Restore for the next start.
    setTimeout(() => {
      if (this.musicBus && !this._playing) {
        this.musicBus.gain.setTargetAtTime(this._ducked ? this.musicVolume * 0.35 : this.musicVolume, this.ctx.currentTime, 0.05);
      }
    }, fade * 1000 + 100);
  }

  setIntensity(v) {
    this.intensity = Math.max(0, Math.min(1, v));
  }

  _schedule() {
    if (!this._playing || !this.ctx) return;
    const spb = 60 / 96 / 4; // 16th note at 96 BPM
    const ahead = this.ctx.currentTime + 0.35;
    let guard = 0;
    while (this._nextTime < ahead && guard++ < 32) {
      this._playStep(this._step, this._nextTime);
      this._nextTime += spb;
      this._step = (this._step + 1) % 16;
      if (this._step === 0) this._bar = (this._bar + 1) % 8;
    }
  }

  _playStep(step, t) {
    const bar = this._bar;
    const intense = this.intensity;
    const chords = [
      [38, 50, 57], // Dm
      [38, 50, 57],
      [34, 46, 53], // Bb
      [36, 48, 55], // C
      [38, 50, 57],
      [34, 46, 53],
      [31, 43, 50], // Gm
      [33, 45, 52], // A
    ];
    const [bassMidi, , ] = chords[bar];

    // Taiko on beats 1 & 3, pickup on the "and" of 4.
    if (step === 0 || step === 8 || (step === 14 && bar % 2 === 1)) {
      this._taiko(t, step === 0 ? 1 : 0.7);
    }
    // Bass on 1 and the "and" of 3.
    if (step === 0) this._bass(t, midiToFreq(bassMidi), 0.5);
    if (step === 6) this._bass(t, midiToFreq(bassMidi + 12), 0.28);
    if (step === 10) this._bass(t, midiToFreq(bassMidi), 0.34);

    // Koto pluck pattern, denser as intensity rises.
    const pluckPattern = intense > 0.35
      ? [2, 5, 7, 10, 12, 15]
      : [2, 7, 12];
    if (pluckPattern.includes(step)) {
      const idx = (bar * 3 + step) % SCALE.length;
      const note = SCALE[(idx + 5) % SCALE.length] + (intense > 0.6 && step % 4 === 0 ? 12 : 0);
      this._pluck(t, midiToFreq(note), 0.16 + (step === 2 ? 0.06 : 0));
    }

    // Shaker on 8ths once the round heats up.
    if (intense > 0.18 && step % 2 === 0) this._shaker(t, step % 4 === 0 ? 0.12 : 0.06);

    // Bell accents every 4 bars.
    if (bar % 4 === 0 && step === 4) {
      this._bell(t, midiToFreq(SCALE[6] + (intense > 0.5 ? 12 : 0)), 0.1);
    }
  }

  _env(node, t, attack, hold, release, peak = 1) {
    const g = node.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.setValueAtTime(Math.max(0.0002, peak), t + attack + hold);
    g.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  }

  _taiko(t, vel) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(132, t);
    osc.frequency.exponentialRampToValueAtTime(46, t + 0.22);
    const gain = ctx.createGain();
    this._env(gain, t, 0.004, 0.02, 0.32, 0.55 * vel);
    osc.connect(gain).connect(this.musicBus);
    osc.start(t);
    osc.stop(t + 0.45);

    const noise = ctx.createBufferSource();
    noise.buffer = this._noise;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(900, t);
    filt.frequency.exponentialRampToValueAtTime(180, t + 0.18);
    const ng = ctx.createGain();
    this._env(ng, t, 0.002, 0.01, 0.15, 0.32 * vel);
    noise.connect(filt).connect(ng).connect(this.musicBus);
    noise.start(t);
    noise.stop(t + 0.25);
  }

  _bass(t, freq, vel) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    this._env(g, t, 0.01, 0.08, 0.4, vel * 0.5);
    osc.connect(g).connect(this.musicBus);
    osc.start(t);
    osc.stop(t + 0.6);
  }

  _pluck(t, freq, vel) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(freq * 2.002, t);
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(3800, t);
    filt.frequency.exponentialRampToValueAtTime(700, t + 0.25);
    const g = ctx.createGain();
    this._env(g, t, 0.004, 0.02, 0.4, vel);
    const g2 = ctx.createGain();
    g2.gain.value = 0.18;
    osc.connect(g);
    osc2.connect(g2).connect(g);
    g.connect(this.musicBus);
    g.connect(this.reverbSend);
    osc.start(t);
    osc2.start(t);
    osc.stop(t + 0.6);
    osc2.stop(t + 0.6);
  }

  _shaker(t, vel) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    const filt = ctx.createBiquadFilter();
    filt.type = 'highpass';
    filt.frequency.value = 6000;
    const g = ctx.createGain();
    this._env(g, t, 0.002, 0.008, 0.06, vel);
    src.connect(filt).connect(g).connect(this.musicBus);
    src.start(t, Math.random() * 1.2, 0.1);
  }

  _bell(t, freq, vel) {
    const ctx = this.ctx;
    for (const [mult, amp] of [[1, 1], [2.76, 0.35], [5.4, 0.12]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      const g = ctx.createGain();
      this._env(g, t, 0.003, 0.02, 1.2, vel * amp);
      osc.connect(g);
      g.connect(this.musicBus);
      g.connect(this.reverbSend);
      osc.start(t);
      osc.stop(t + 1.4);
    }
  }

  // -------------------------------------------------------------------------
  // SFX
  // -------------------------------------------------------------------------

  _noiseSource(duration, when = 0) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    src.start(this.ctx.currentTime + when, Math.random() * 1.4);
    src.stop(this.ctx.currentTime + when + duration);
    return src;
  }

  /** Airy blade swoosh. */
  playSlice(strength = 1) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = this._noiseSource(0.24);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    const f0 = 900 + Math.random() * 500;
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(f0 * 2.8, t + 0.07);
    bp.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + 0.2);
    const g = ctx.createGain();
    const peak = 0.16 * Math.min(1.5, strength);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.035);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    src.connect(bp).connect(g);
    g.connect(this.sfxBus);
    g.connect(this.reverbSend);

    // metallic "shing"
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(2600 + Math.random() * 900, t);
    osc.frequency.exponentialRampToValueAtTime(1500, t + 0.12);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.05 * strength, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(og).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  /** Per-fruit splat. Lower pitch for bigger fruit. */
  playSplat(typeId = 'apple') {
    if (!this.ready) return;
    const pitches = {
      watermelon: 120, pineapple: 160, banana: 180, apple: 200, orange: 215, strawberry: 300, bomb: 200,
    };
    const base = pitches[typeId] || 200;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = this._noiseSource(0.2);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(420, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
    src.connect(lp).connect(g).connect(this.sfxBus);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(base * 1.6, t);
    osc.frequency.exponentialRampToValueAtTime(base * 0.7, t + 0.14);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(og).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  playBomb() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // sub drop
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(110, t);
    sub.frequency.exponentialRampToValueAtTime(24, t + 0.9);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.75, t + 0.02);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    sub.connect(sg).connect(this.sfxBus);
    sub.start(t);
    sub.stop(t + 1.5);

    // blast
    const src = this._noiseSource(1.1);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
    src.connect(lp).connect(g);
    g.connect(this.sfxBus);
    g.connect(this.reverbSend);

    // debris crackle
    for (let i = 0; i < 7; i++) {
      const at = 0.05 + Math.random() * 0.5;
      const s = this._noiseSource(0.06, at);
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 1200 + Math.random() * 2000;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, t + at);
      cg.gain.exponentialRampToValueAtTime(0.12, t + at + 0.005);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.06);
      s.connect(f).connect(cg).connect(this.sfxBus);
    }
  }

  /** Bright ascending chime, pitch climbs with the combo length. */
  playCombo(count = 2) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const notes = [69, 72, 74, 77, 79, 81, 84];
    const n = Math.min(3, 1 + Math.floor(count / 2));
    for (let i = 0; i < n; i++) {
      const t = t0 + i * 0.055;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = midiToFreq(notes[Math.min(notes.length - 1, i + Math.min(4, count))]);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      osc.connect(g);
      g.connect(this.sfxBus);
      g.connect(this.reverbSend);
      osc.start(t);
      osc.stop(t + 0.55);
    }
  }

  playClick() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(720, t);
    osc.frequency.exponentialRampToValueAtTime(420, t + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  playHover() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1180;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.045, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + 0.08);
  }

  playStrike() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + 0.32);
    const src = this._noiseSource(0.2);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 400;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.18, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    src.connect(f).connect(ng).connect(this.sfxBus);
  }

  playGameOver() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const notes = [62, 57, 53, 50];
    notes.forEach((m, i) => {
      const t = t0 + i * 0.19;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = midiToFreq(m);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      osc.connect(g);
      g.connect(this.sfxBus);
      g.connect(this.reverbSend);
      osc.start(t);
      osc.stop(t + 1.2);
    });
    this._taiko(t0, 1);
    this._taiko(t0 + 0.36, 0.7);
  }

  playRecord() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    [69, 74, 77, 81, 86].forEach((m, i) => {
      const t = t0 + i * 0.09;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = midiToFreq(m);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.17, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      osc.connect(g);
      g.connect(this.sfxBus);
      g.connect(this.reverbSend);
      osc.start(t);
      osc.stop(t + 1);
    });
  }

  /** Short buzz used by phone-triggered UI actions. */
  vibrate(pattern = 12) {
    try {
      navigator.vibrate?.(pattern);
    } catch {}
  }
}

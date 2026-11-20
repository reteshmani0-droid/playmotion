/**
 * 3D Cricket game module.
 *
 * Uses Three.js (vendored) for real 3D rendering. The host's 2D canvas is
 * hidden while cricket is active; a WebGL canvas is appended to the body.
 */
import { WORLD } from '../game/config.js';
import { clamp, rand } from '../../shared/util.js';

let THREE = null;
let loadingPromise = null;

export function createCricket() {
  if (!THREE && !loadingPromise) {
    loadingPromise = import('/vendor/three/three.module.js')
      .then((m) => { THREE = m; })
      .catch((e) => { console.error('Failed to load Three.js', e); loadingPromise = null; });
  }

  const state = {
    score: 0, lives: 10, combo: 0, comboTimer: 0, comboWindow: 0.5, maxCombo: 0,
    sliced: 0, missed: 0, time: 0, running: false, runs: 0, wickets: 0,
    balls: 0, overs: 0, maxOvers: 2,
  };

  let host = null;
  let glCanvas = null;
  let renderer = null;
  let scene = null;
  let camera = null;
  let ball = null;
  let bat = null;
  let batsman = null;
  let bowler = null;
  let stumpsBowler = null;
  let stumpsBatsman = null;
  let pitch = null;

  // ball state
  let ballState = 'idle'; // 'idle' | 'bowling' | 'hit' | 'done'
  let ballPos = null;
  let ballVel = null;
  let ballStart = null;
  let ballTarget = null;
  let bowlTimer = 0;
  let hitWindow = false;
  let hitTime = 0;       // seconds since ball entered hit window
  let swingCooldown = 0;
  let batSwing = 0;      // 0..1 animation
  let batSwinging = false;
  let lastSwingSpeed = 0;
  let resultText = '';
  let resultTimer = 0;
  let gameOverTimer = 0;

  // crowd/ambient
  let t0 = 0;

  function reset() {
    state.score = 0; state.runs = 0; state.wickets = 0; state.balls = 0;
    state.overs = 0; state.time = 0; state.running = false;
    state.lives = 10; state.combo = 0; state.comboTimer = 0; state.maxCombo = 0;
    state.sliced = 0; state.missed = 0;
    ballState = 'idle';
    bowlTimer = 1.2;
    hitWindow = false;
    hitTime = 0;
    batSwing = 0; batSwinging = false;
    resultText = ''; resultTimer = 0;
    gameOverTimer = 0;
    if (host) host.effects.reset();
  }

  function start() {
    reset();
    state.running = true;
    ensureScene();
  }

  function cleanup() {
    if (glCanvas && glCanvas.parentNode) glCanvas.parentNode.removeChild(glCanvas);
    glCanvas = null;
    if (renderer) { renderer.dispose(); renderer = null; }
    scene = null; camera = null; ball = null; bat = null;
    batsman = null; bowler = null; stumpsBowler = null; stumpsBatsman = null; pitch = null;
  }

  function ensureScene() {
    if (scene) return;
    if (!THREE) return;
    const T = THREE;
    if (!ballPos) { ballPos = new T.Vector3(); ballVel = new T.Vector3(); ballStart = new T.Vector3(); ballTarget = new T.Vector3(); }
    // (stage hidden once scene is ready)

    glCanvas = document.createElement('canvas');
    glCanvas.id = 'cricket-gl';
    glCanvas.style.position = 'fixed';
    glCanvas.style.inset = '0';
    glCanvas.style.width = '100vw';
    glCanvas.style.height = '100vh';
    glCanvas.style.zIndex = '1';
    document.body.appendChild(glCanvas);

    renderer = new T.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;

    scene = new T.Scene();
    scene.background = new T.Color(0x87ceeb);
    scene.fog = new T.Fog(0x87ceeb, 40, 120);

    camera = new T.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position.set(0, 6, 18);
    camera.lookAt(0, 1, 0);

    // lights
    const hemi = new T.HemisphereLight(0xffffff, 0x446633, 0.7);
    scene.add(hemi);
    const sun = new T.DirectionalLight(0xffffff, 1.1);
    sun.position.set(10, 20, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    sun.shadow.camera.left = -20;
    sun.shadow.camera.right = 20;
    sun.shadow.camera.top = 20;
    sun.shadow.camera.bottom = -20;
    scene.add(sun);

    // pitch
    const pitchGeo = new T.PlaneGeometry(4, 22);
    const pitchMat = new T.MeshStandardMaterial({ color: 0xc9a86a, roughness: 0.8 });
    pitch = new T.Mesh(pitchGeo, pitchMat);
    pitch.rotation.x = -Math.PI / 2;
    pitch.receiveShadow = true;
    scene.add(pitch);

    // pitch lines
    const lineMat = new T.MeshBasicMaterial({ color: 0xffffff });
    const creaseGeo = new T.PlaneGeometry(4, 0.08);
    const crease1 = new T.Mesh(creaseGeo, lineMat);
    crease1.rotation.x = -Math.PI / 2;
    crease1.position.set(0, 0.01, 9);
    scene.add(crease1);
    const crease2 = new T.Mesh(creaseGeo, lineMat);
    crease2.rotation.x = -Math.PI / 2;
    crease2.position.set(0, 0.01, -9);
    scene.add(crease2);

    // stumps
    function makeStumps(z) {
      const g = new T.Group();
      const wood = new T.MeshStandardMaterial({ color: 0xf5deb3, roughness: 0.6 });
      for (let i = -1; i <= 1; i++) {
        const cyl = new T.Mesh(new T.CylinderGeometry(0.06, 0.06, 0.7, 8), wood);
        cyl.position.set(i * 0.18, 0.35, 0);
        cyl.castShadow = true;
        g.add(cyl);
      }
      // bails
      const bail = new T.Mesh(new T.CylinderGeometry(0.03, 0.03, 0.22, 6), wood);
      bail.rotation.z = Math.PI / 2;
      bail.position.set(0, 0.72, 0);
      g.add(bail);
      g.position.set(0, 0, z);
      scene.add(g);
      return g;
    }
    stumpsBowler = makeStumps(-10);
    stumpsBatsman = makeStumps(9);

    // batsman
    batsman = new T.Group();
    const bodyMat = new T.MeshStandardMaterial({ color: 0x1e88e5 });
    const body = new T.Mesh(new T.BoxGeometry(0.5, 1.0, 0.3), bodyMat);
    body.position.y = 0.9;
    body.castShadow = true;
    batsman.add(body);
    const head = new T.Mesh(new T.SphereGeometry(0.22, 12, 8), new T.MeshStandardMaterial({ color: 0xffcc99 }));
    head.position.y = 1.6;
    head.castShadow = true;
    batsman.add(head);
    // legs
    const legMat = new T.MeshStandardMaterial({ color: 0xffffff });
    const legL = new T.Mesh(new T.BoxGeometry(0.18, 0.7, 0.18), legMat);
    legL.position.set(-0.15, 0.35, 0);
    batsman.add(legL);
    const legR = new T.Mesh(new T.BoxGeometry(0.18, 0.7, 0.18), legMat);
    legR.position.set(0.15, 0.35, 0);
    batsman.add(legR);
    batsman.position.set(0, 0, 9);
    scene.add(batsman);

    // bat
    bat = new T.Group();
    const batBlade = new T.Mesh(new T.BoxGeometry(0.12, 0.06, 1.0), new T.MeshStandardMaterial({ color: 0xd2b48c, roughness: 0.5 }));
    batBlade.position.set(0, 0, 0.5);
    batBlade.castShadow = true;
    bat.add(batBlade);
    const batHandle = new T.Mesh(new T.CylinderGeometry(0.03, 0.03, 0.35, 8), new T.MeshStandardMaterial({ color: 0x5d3a1a }));
    batHandle.position.set(0, 0, -0.1);
    batHandle.rotation.x = Math.PI / 2;
    bat.add(batHandle);
    bat.position.set(0.4, 1.0, 9);
    scene.add(bat);

    // bowler
    bowler = new T.Group();
    const bBody = new T.Mesh(new T.BoxGeometry(0.45, 0.9, 0.28), new T.MeshStandardMaterial({ color: 0xe53935 }));
    bBody.position.y = 0.85;
    bBody.castShadow = true;
    bowler.add(bBody);
    const bHead = new T.Mesh(new T.SphereGeometry(0.2, 12, 8), new T.MeshStandardMaterial({ color: 0xffcc99 }));
    bHead.position.y = 1.5;
    bowler.add(bHead);
    bowler.position.set(0, 0, -10);
    scene.add(bowler);

    // ball
    ball = new T.Mesh(new T.SphereGeometry(0.09, 16, 12), new T.MeshStandardMaterial({ color: 0xcc2222, roughness: 0.4 }));
    ball.castShadow = true;
    ball.visible = false;
    scene.add(ball);

    // boundary (simple circle line)
    const ringGeo = new T.RingGeometry(19.5, 20, 64);
    const ringMat = new T.MeshBasicMaterial({ color: 0xffffff, side: T.DoubleSide, transparent: true, opacity: 0.4 });
    const ring = new T.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    scene.add(ring);

    // ground plane (outfield)
    const groundGeo = new T.PlaneGeometry(60, 60);
    const groundMat = new T.MeshStandardMaterial({ color: 0x3a7d3a, roughness: 0.9 });
    const ground = new T.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    scene.add(ground);

    t0 = performance.now() / 1000;
    const stage = document.getElementById('stage');
    if (stage) stage.style.display = 'none';
  }

  function bowl() {
    if (!THREE || !ballPos) return;
    ballState = 'bowling';
    ball.position.set(0, 1.2, -10);
    ballPos.copy(ball.position);
    // target: batsman stumps area, slight variation
    const targetX = rand(-0.6, 0.6);
    const targetZ = 9;
    ballTarget.set(targetX, 0.3, targetZ);
    const dist = ballTarget.z - ballPos.z; // ~20
    const speed = rand(18, 26); // units/s
    const flight = dist / speed;
    ballVel.set(
      (targetX - ballPos.x) / flight,
      (0.3 - ballPos.y) / flight + 0.5 * 9.8 * flight * 0.5, // arc
      dist / flight,
    );
    // adjust vy for gravity
    ballVel.y = (0.3 - ballPos.y + 0.5 * 9.8 * flight * flight) / flight;
    hitWindow = false;
    hitTime = 0;
    batSwinging = false;
    batSwing = 0;
  }

  function update(dt, h) {
    host = h;
    if (!state.running) {
      // still render scene if exists
      if (scene) renderScene();
      return;
    }
    state.time += dt;

    ensureScene();

    if (!THREE) {
      const ctx = host.ctx;
      const canvas = host.canvas;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#05060b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffd76a';
      ctx.font = 'bold 48px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Loading 3D engine…', canvas.width / 2, canvas.height / 2);
      return;
    }

    // swing cooldown
    if (swingCooldown > 0) swingCooldown -= dt;
    // bat swing animation
    if (batSwinging) {
      batSwing += dt * 8;
      if (batSwing >= 1) { batSwing = 1; batSwinging = false; }
    } else if (batSwing > 0) {
      batSwing = Math.max(0, batSwing - dt * 4);
    }

    // bat rotation based on swing
    if (bat) {
      const swingAngle = -Math.PI / 2 + batSwing * Math.PI * 1.1;
      bat.rotation.x = swingAngle;
      bat.position.set(0.4, 1.0, 9);
    }

    // bowler animation (run-up during bowling)
    if (bowler) {
      if (ballState === 'bowling') {
        bowler.position.z = -10 + (ballPos.z + 10) * 0.4;
        bowler.position.z = Math.min(bowler.position.z, -8.5);
      } else {
        bowler.position.z = -10;
      }
    }

    // bowl timer
    if (ballState === 'idle') {
      bowlTimer -= dt;
      if (bowlTimer <= 0) bowl();
    } else if (ballState === 'bowling') {
      // gravity
      ballVel.y -= 9.8 * dt;
      ballPos.addScaledVector(ballVel, dt);
      ball.position.copy(ballPos);
      // spin visual
      ball.rotation.x += dt * 12;
      ball.rotation.z += dt * 6;

      // hit window: ball within 2 units of batsman z (9)
      const dz = ballPos.z - 9;
      if (Math.abs(dz) < 2.0 && !hitWindow) {
        hitWindow = true;
        hitTime = 0;
      }
      if (hitWindow) hitTime += dt;

      // swing detection from host pointers
      if (!batSwinging && swingCooldown <= 0 && ballState === 'bowling') {
        const blades = h.pointers.blades();
        for (const b of blades) {
          if (b.speed > 400 && Math.abs(b.vx) > 200) {
            // only swing if ball is in the hitting zone
            if (ballPos.z > 4 && ballPos.z < 12) {
              batSwinging = true;
              batSwing = 0;
              swingCooldown = 0.6;
              lastSwingSpeed = b.speed;
              tryHit(h);
            }
            break;
          }
        }
      }

      // ball passed batsman
      if (ballPos.z > 11) {
        ballState = 'done';
        if (!batSwinging) {
          // no swing
          if (Math.random() < 0.35) {
            // bowled
            wicket('bowled');
          } else {
            dotBall();
          }
        }
        ball.visible = false;
        scheduleNext();
      }
    }

    // result text timer
    if (resultTimer > 0) resultTimer -= dt;

    // game over check
    if (state.wickets >= 10 || (state.balls >= state.maxOvers * 6)) {
      if (gameOverTimer === 0) {
        gameOverTimer = 2.0;
        state.running = false;
        h.audio?.duck(true);
        h.emit('gameover', {
          reason: state.wickets >= 10 ? 'wickets' : 'overs',
          score: state.runs,
          sliced: state.balls,
          maxCombo: state.maxCombo,
          missed: state.wickets,
          time: Math.round(state.time),
        });
      }
    }

    renderScene();
  }

  function tryHit(h) {
    // time until ball reaches batsman (z=9)
    const timeToContact = (9 - ballPos.z) / (ballVel.z || 1);
    const err = Math.abs(timeToContact);
    let runs = 0;
    let label = '';
    if (err < 0.08) { runs = 6; label = 'SIX!'; h.audio?.playCombo(6); }
    else if (err < 0.2) { runs = 4; label = 'FOUR!'; h.audio?.playCombo(4); }
    else if (err < 0.4) { runs = 2; label = '2 RUNS'; h.audio?.playSlice(1.2); }
    else { runs = 1; label = '1 RUN'; h.audio?.playSlice(0.9); }

    // small chance of caught
    if (runs >= 4 && Math.random() < 0.15) {
      runs = 0;
      label = 'CAUGHT!';
      wicket('caught');
    } else if (runs > 0) {
      state.runs += runs;
      state.score = state.runs;
      state.sliced++;
      state.combo = state.comboTimer > 0 ? state.combo + 1 : 1;
      state.comboTimer = 0.5;
      state.maxCombo = Math.max(state.maxCombo, state.combo);
      h.effects.juice(WORLD.w / 2, WORLD.h / 2, ['#ffd76a', '#fff', '#ff9d1c'], 24, 1.2);
      h.effects.popup(WORLD.w / 2, WORLD.h * 0.35, label, { color: runs >= 4 ? '#ffd76a' : '#fff6df', size: runs >= 6 ? 96 : 64, life: 1.2 });
      if (runs >= 4) h.effects.shockwave(WORLD.w / 2, WORLD.h / 2, '#ffd76a', 300, 14);
      h.emit('slice', { type: 'cricket', points: runs, combo: state.combo, x: 0, y: 0, speed: lastSwingSpeed });
    } else if (label === 'CAUGHT!') {
      h.effects.flash('#ff2f4f', 0.3);
      h.effects.popup(WORLD.w / 2, WORLD.h * 0.35, label, { color: '#ff7b8a', size: 72, life: 1.2 });
      h.emit('miss', { lives: 10 - state.wickets });
    }
    resultText = label;
    resultTimer = 1.4;
    // stop ball
    ballState = 'done';
    ball.visible = false;
    scheduleNext();
  }

  function wicket(kind) {
    state.wickets++;
    state.missed++;
    state.combo = 0;
    state.comboTimer = 0;
    resultText = kind === 'bowled' ? 'BOWLED!' : 'CAUGHT!';
    resultTimer = 1.4;
    host?.effects?.flash('#ff2f4f', 0.25);
    host?.effects?.shakeScreen(12, 0.3);
    host?.audio?.playStrike();
    host?.effects?.popup(WORLD.w / 2, WORLD.h * 0.35, resultText, { color: '#ff7b8a', size: 72, life: 1.2 });
    host?.emit('miss', { lives: 10 - state.wickets });
  }

  function dotBall() {
    resultText = 'DOT BALL';
    resultTimer = 1.0;
    host?.audio?.playSlice(0.6);
  }

  function scheduleNext() {
    state.balls++;
    if (state.balls % 6 === 0) state.overs++;
    ballState = 'idle';
    bowlTimer = rand(1.2, 1.8);
    hitWindow = false;
    batSwinging = false;
    batSwing = 0;
    swingCooldown = 0;
  }

  function renderScene() {
    if (!renderer || !scene || !camera) return;
    // camera slight sway
    const t = (performance.now() / 1000) - t0;
    camera.position.x = Math.sin(t * 0.3) * 0.6;
    camera.position.y = 6 + Math.sin(t * 0.5) * 0.2;
    camera.lookAt(0, 1, 0);
    renderer.render(scene, camera);

    // Draw HUD-ish overlay text on the 2D canvas? The host draws HUD separately.
    // Draw result text on glCanvas via a 2D overlay? Use DOM overlay instead.
    updateResultOverlay();
  }

  function updateResultOverlay() {
    // Reuse the host's toast? Just update a DOM element.
    let el = document.getElementById('cricket-result');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cricket-result';
      el.style.cssText = 'position:fixed;left:50%;top:22%;transform:translateX(-50%);z-index:5;font-size:4rem;font-weight:900;letter-spacing:0.05em;text-shadow:0 4px 20px rgba(0,0,0,0.6);pointer-events:none;transition:opacity 0.3s;';
      document.body.appendChild(el);
    }
    if (resultTimer > 0 && resultText) {
      el.textContent = resultText;
      el.style.opacity = '1';
      const color = resultText.includes('SIX') || resultText.includes('FOUR') ? '#ffd76a' : resultText.includes('RUN') ? '#fff6df' : '#ff7b8a';
      el.style.color = color;
    } else {
      el.style.opacity = '0';
    }
  }

  function render(ctx, h) {
    // no-op: Three.js renders in update via renderScene
  }

  function isOver() { return !state.running && state.balls > 0 && (state.wickets >= 10 || state.balls >= state.maxOvers * 6); }

  return {
    id: 'cricket', title: 'Cricket', state,
    init(h) { host = h; reset(); },
    start() { start(); },
    update(dt, h) { host = h; update(dt, h); },
    render(ctx, h) { render(ctx, h); },
    cleanup() { cleanup(); removeResult(); },
    isOver() { return !state.running && state.balls > 0; },
    get mode() { return 'classic'; },
    get _debug() { return { ballState, bowlTimer, hitWindow, hitTime, sceneReady: !!scene }; },
  };
}

function removeResult() {
  const el = document.getElementById('cricket-result');
  if (el) el.parentNode.removeChild(el);
  const stage = document.getElementById('stage');
  if (stage) stage.style.display = '';
}

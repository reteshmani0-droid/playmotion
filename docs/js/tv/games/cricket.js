/**
 * 3D Cricket game module — PlayMotion.
 *
 * Bat follows the player's hand (pointer → 3D bat position). Two phases:
 *   BATTING  — player bats for 2 overs (12 balls), score runs.
 *   BOWLING  — player bowls for 2 overs, AI batsman plays; get wickets.
 * Final: higher score wins.
 *
 * Visuals: textured pitch/outfield, layered lighting, detailed procedural
 * models (tapered bat, stumps with bails, humanoid players), shadows.
 */
import { WORLD } from '../game/config.js';
import { clamp, rand, randInt } from '../../shared/util.js';

let THREE = null;
let loadingPromise = null;

export function createCricket() {
  if (!THREE && !loadingPromise) {
    loadingPromise = import('../../../vendor/three/three.module.js')
      .then((m) => { THREE = m; })
      .catch((e) => { console.error('Failed to load Three.js', e); loadingPromise = null; });
  }

  const T = () => THREE;

  const state = {
    score: 0, runs: 0, wickets: 0, balls: 0, overs: 0, maxOvers: 2,
    oppRuns: 0, oppWickets: 0, oppBalls: 0,
    time: 0, running: false, lives: 10,
    combo: 0, comboTimer: 0, comboWindow: 0.5, maxCombo: 0,
    sliced: 0, missed: 0,
    phase: 'batting', // 'batting' | 'bowling' | 'result'
  };

  let host = null;
  let glCanvas = null, renderer = null, scene = null, camera = null;
  let ball = null, bat = null, batsman = null, bowler = null;
  let stumpsBat = null, stumpsBowl = null;
  let pitch = null, ground = null;
  let sky = null;

  // ball state
  let ballState = 'idle';
  let ballPos = null, ballVel = null, ballTarget = null;
  let bowlTimer = 0;
  let hitWindow = false, hitTime = 0;
  let swingCooldown = 0;
  let batSwing = 0, batSwinging = false;
  let lastSwingSpeed = 0;
  let resultText = '', resultTimer = 0;
  let gameOverTimer = 0;
  let t0 = 0;

  // batting input
  let handX = 0.5, handY = 0.5; // normalized 0..1
  let batTargetX = 0, batTargetY = 1.0;

  // bowling input
  let bowlAim = 0; // -1..1
  let bowlPower = 0;
  let bowlCharging = false;

  // AI batsman
  let aiSwingTimer = 0;

  function reset() {
    state.score = 0; state.runs = 0; state.wickets = 0; state.balls = 0;
    state.overs = 0; state.oppRuns = 0; state.oppWickets = 0; state.oppBalls = 0;
    state.time = 0; state.running = false; state.phase = 'batting';
    state.lives = 10; state.combo = 0; state.comboTimer = 0; state.maxCombo = 0;
    state.sliced = 0; state.missed = 0;
    ballState = 'idle'; bowlTimer = 1.4; hitWindow = false; hitTime = 0;
    swingCooldown = 0; batSwing = 0; batSwinging = false;
    resultText = ''; resultTimer = 0; gameOverTimer = 0;
    handX = 0.5; handY = 0.5; batTargetX = 0; batTargetY = 1.0;
    bowlAim = 0; bowlPower = 0; bowlCharging = false;
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
    batsman = null; bowler = null; stumpsBat = null; stumpsBowl = null;
    pitch = null; ground = null; sky = null;
    ['cricket-result','cricket-phase','cricket-scorebug'].forEach(id => {
      const el = document.getElementById(id); if (el) el.parentNode.removeChild(el);
    });
    const stage = document.getElementById('stage');
    if (stage) stage.style.display = '';
  }

  // ---------- textures ----------
  function makeGrassTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3a7d3a';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 4000; i++) {
      const x = Math.random() * 256, y = Math.random() * 256;
      ctx.fillStyle = `rgba(${40 + Math.random()*30}, ${100 + Math.random()*40}, ${40 + Math.random()*20}, 0.6)`;
      ctx.fillRect(x, y, 2, 2);
    }
    const tex = new (T()).CanvasTexture(c);
    tex.wrapS = tex.wrapT = (T()).RepeatWrapping;
    tex.repeat.set(8, 8);
    return tex;
  }

  function makePitchTexture() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#c9a86a'); g.addColorStop(0.5, '#b8945a'); g.addColorStop(1, '#a8844a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 512);
    for (let i = 0; i < 2000; i++) {
      ctx.fillStyle = `rgba(${160 + Math.random()*30}, ${130 + Math.random()*20}, ${80 + Math.random()*20}, 0.4)`;
      ctx.fillRect(Math.random()*128, Math.random()*512, 1, 1);
    }
    const tex = new (T()).CanvasTexture(c);
    return tex;
  }

  function makeWoodTexture() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 64, 0);
    g.addColorStop(0, '#8b6f47'); g.addColorStop(0.5, '#a0825a'); g.addColorStop(1, '#7a5f3a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 256);
    for (let i = 0; i < 80; i++) {
      ctx.strokeStyle = `rgba(${100 + Math.random()*40}, ${70 + Math.random()*30}, ${40 + Math.random()*20}, 0.4)`;
      ctx.lineWidth = 0.5 + Math.random();
      ctx.beginPath();
      ctx.moveTo(Math.random()*64, 0);
      ctx.lineTo(Math.random()*64, 256);
      ctx.stroke();
    }
    const tex = new (T()).CanvasTexture(c);
    return tex;
  }

  function ensureScene() {
    if (scene) return;
    const TH = T();
    if (!TH) return;
    window.__ensureRan = true;
    try {
    if (!ballPos) { ballPos = new TH.Vector3(); ballVel = new TH.Vector3(); ballTarget = new TH.Vector3(); }

    const stage = document.getElementById('stage');
    if (stage) stage.style.display = 'none';

    glCanvas = document.createElement('canvas');
    glCanvas.id = 'cricket-gl';
    glCanvas.style.position = 'fixed';
    glCanvas.style.inset = '0';
    glCanvas.style.width = '100vw';
    glCanvas.style.height = '100vh';
    glCanvas.style.zIndex = '1';
    document.body.appendChild(glCanvas);

    renderer = new TH.WebGLRenderer({ canvas: glCanvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = TH.PCFSoftShadowMap;
    renderer.toneMapping = TH.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    scene = new TH.Scene();
    scene.background = new TH.Color(0x87ceeb);
    scene.fog = new TH.Fog(0xc9e2f0, 60, 160);

    camera = new TH.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 300);
    camera.position.set(0, 9, 22);
    camera.lookAt(0, 1, 0);

    // lights
    const hemi = new TH.HemisphereLight(0xfff4e0, 0x3a5f3a, 0.6);
    scene.add(hemi);
    const sun = new TH.DirectionalLight(0xfff4e0, 1.3);
    sun.position.set(15, 30, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 80;
    sun.shadow.camera.left = -25; sun.shadow.camera.right = 25;
    sun.shadow.camera.top = 25; sun.shadow.camera.bottom = -25;
    scene.add(sun);
    const fill = new TH.DirectionalLight(0x8ab4ff, 0.3);
    fill.position.set(-10, 15, -10);
    scene.add(fill);

    // sky dome
    const skyGeo = new TH.SphereGeometry(150, 32, 16);
    const skyMat = new TH.MeshBasicMaterial({ color: 0x87ceeb, side: TH.BackSide });
    sky = new TH.Mesh(skyGeo, skyMat);
    scene.add(sky);

    // ground (outfield)
    const groundGeo = new TH.PlaneGeometry(120, 120);
    const groundMat = new TH.MeshStandardMaterial({ map: makeGrassTexture(), roughness: 0.9 });
    ground = new TH.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    scene.add(ground);

    // pitch
    const pitchGeo = new TH.PlaneGeometry(3.2, 20);
    const pitchMat = new TH.MeshStandardMaterial({ map: makePitchTexture(), roughness: 0.7 });
    pitch = new TH.Mesh(pitchGeo, pitchMat);
    pitch.rotation.x = -Math.PI / 2;
    pitch.position.y = 0.01;
    pitch.receiveShadow = true;
    scene.add(pitch);

    // crease lines
    const creaseMat = new TH.MeshBasicMaterial({ color: 0xffffff });
    function crease(z) {
      const m = new TH.Mesh(new TH.PlaneGeometry(3.2, 0.06), creaseMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(0, 0.02, z);
      scene.add(m);
    }
    crease(8.5); crease(-8.5);

    // stumps
    function makeStumps(z, color = 0xf5deb3) {
      const g = new TH.Group();
      const woodMat = new TH.MeshStandardMaterial({ map: makeWoodTexture(), roughness: 0.5 });
      for (let i = -1; i <= 1; i++) {
        const cyl = new TH.Mesh(new TH.CylinderGeometry(0.045, 0.05, 0.72, 12), woodMat);
        cyl.position.set(i * 0.17, 0.36, 0);
        cyl.castShadow = true;
        g.add(cyl);
      }
      const bailMat = new TH.MeshStandardMaterial({ color: 0xf5deb3, roughness: 0.4 });
      const bail = new TH.Mesh(new TH.CylinderGeometry(0.025, 0.025, 0.2, 8), bailMat);
      bail.rotation.z = Math.PI / 2;
      bail.position.set(0, 0.74, 0);
      g.add(bail);
      g.position.set(0, 0, z);
      scene.add(g);
      return g;
    }
    stumpsBowl = makeStumps(-9);
    stumpsBat = makeStumps(9);

    // batsman (detailed humanoid)
    batsman = new TH.Group();
    const skinMat = new TH.MeshStandardMaterial({ color: 0xffcc99, roughness: 0.6 });
    const shirtMat = new TH.MeshStandardMaterial({ color: 0x1e88e5, roughness: 0.7 });
    const pantsMat = new TH.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    // torso
    const torso = new TH.Mesh(new TH.BoxGeometry(0.45, 0.65, 0.25), shirtMat);
    torso.position.y = 1.15; torso.castShadow = true; batsman.add(torso);
    // head
    const head = new TH.Mesh(new TH.SphereGeometry(0.2, 16, 12), skinMat);
    head.position.y = 1.62; head.castShadow = true; batsman.add(head);
    // helmet
    const helmet = new TH.Mesh(new TH.SphereGeometry(0.22, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), new TH.MeshStandardMaterial({ color: 0x1e88e5 }));
    helmet.position.y = 1.62; batsman.add(helmet);
    // arms
    const armMat = new TH.MeshStandardMaterial({ color: 0x1e88e5 });
    const armL = new TH.Mesh(new TH.CylinderGeometry(0.06, 0.06, 0.55, 8), armMat);
    armL.position.set(-0.32, 1.15, 0.1); armL.rotation.z = 0.3; armL.castShadow = true; batsman.add(armL);
    const armR = new TH.Mesh(new TH.CylinderGeometry(0.06, 0.06, 0.55, 8), armMat);
    armR.position.set(0.32, 1.15, 0.1); armR.rotation.z = -0.3; armR.castShadow = true; batsman.add(armR);
    // legs
    const legL = new TH.Mesh(new TH.CylinderGeometry(0.08, 0.07, 0.75, 8), pantsMat);
    legL.position.set(-0.12, 0.38, 0); legL.castShadow = true; batsman.add(legL);
    const legR = new TH.Mesh(new TH.CylinderGeometry(0.08, 0.07, 0.75, 8), pantsMat);
    legR.position.set(0.12, 0.38, 0); legR.castShadow = true; batsman.add(legR);
    batsman.position.set(0, 0, 9);
    scene.add(batsman);

    // bat (tapered)
    bat = new TH.Group();
    const batMat = new TH.MeshStandardMaterial({ map: makeWoodTexture(), roughness: 0.4 });
    const blade = new TH.Mesh(new TH.BoxGeometry(0.11, 0.06, 1.05), batMat);
    blade.position.set(0, 0, 0.5); blade.castShadow = true; bat.add(blade);
    // taper
    const taper = new TH.Mesh(new TH.BoxGeometry(0.11, 0.06, 0.15), batMat);
    taper.position.set(0, 0, -0.08); taper.castShadow = true; bat.add(taper);
    const handle = new TH.Mesh(new TH.CylinderGeometry(0.028, 0.032, 0.32, 8), new TH.MeshStandardMaterial({ color: 0x5d3a1a, roughness: 0.6 }));
    handle.position.set(0, 0, -0.32); handle.rotation.x = Math.PI / 2; bat.add(handle);
    bat.position.set(0.4, 1.0, 9);
    scene.add(bat);

    // bowler
    bowler = new TH.Group();
    const bShirt = new TH.MeshStandardMaterial({ color: 0xe53935, roughness: 0.7 });
    const bTorso = new TH.Mesh(new TH.BoxGeometry(0.4, 0.6, 0.22), bShirt);
    bTorso.position.y = 1.1; bTorso.castShadow = true; bowler.add(bTorso);
    const bHead = new TH.Mesh(new TH.SphereGeometry(0.18, 16, 12), skinMat);
    bHead.position.y = 1.55; bowler.add(bHead);
    const bCap = new TH.Mesh(new TH.SphereGeometry(0.19, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new TH.MeshStandardMaterial({ color: 0xe53935 }));
    bCap.position.y = 1.55; bowler.add(bCap);
    const bArm = new TH.Mesh(new TH.CylinderGeometry(0.05, 0.05, 0.5, 8), bShirt);
    bArm.position.set(0.28, 1.1, 0); bArm.rotation.z = -0.4; bowler.add(bArm);
    const bLegL = new TH.Mesh(new TH.CylinderGeometry(0.07, 0.06, 0.7, 8), new TH.MeshStandardMaterial({ color: 0xffffff }));
    bLegL.position.set(-0.1, 0.35, 0); bowler.add(bLegL);
    const bLegR = new TH.Mesh(new TH.CylinderGeometry(0.07, 0.06, 0.7, 8), new TH.MeshStandardMaterial({ color: 0xffffff }));
    bLegR.position.set(0.1, 0.35, 0); bowler.add(bLegR);
    bowler.position.set(0, 0, -9);
    scene.add(bowler);

    // ball
    ball = new TH.Mesh(new TH.SphereGeometry(0.08, 20, 16), new TH.MeshStandardMaterial({ color: 0xcc2222, roughness: 0.3, metalness: 0.1 }));
    ball.castShadow = true;
    ball.visible = false;
    scene.add(ball);

    // boundary rope
    const ropeGeo = new TH.TorusGeometry(28, 0.08, 8, 64);
    const ropeMat = new TH.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    const rope = new TH.Mesh(ropeGeo, ropeMat);
    rope.rotation.x = Math.PI / 2;
    rope.position.y = 0.05;
    scene.add(rope);

    t0 = performance.now() / 1000;
    const stg = document.getElementById('stage');
    if (stg) stg.style.display = 'none';
    } catch (e) { console.error('ensureScene failed:', e && e.message, e && e.stack); }
  }

  function bowl() {
    const TH = T(); if (!TH || !ballPos) return;
    ballState = 'bowling';
    // bowling phase: aim + power from hand
    const aimX = bowlAim * 1.2;
    const speed = 18 + bowlPower * 8;
    ball.position.set(aimX * 0.3, 1.3, -9);
    ballPos.copy(ball.position);
    ballTarget.set(aimX, 0.3, 9);
    const dist = ballTarget.z - ballPos.z;
    const flight = dist / speed;
    ballVel.set(
      (ballTarget.x - ballPos.x) / flight,
      (ballTarget.y - ballPos.y + 0.5 * 9.8 * flight * flight) / flight,
      dist / flight,
    );
    ball.visible = true;
    hitWindow = false; hitTime = 0;
    batSwinging = false; batSwing = 0;
    bowlCharging = false; bowlPower = 0;
  }

  function update(dt, h) {
    host = h;
    if (!state.running) { if (scene) renderScene(); return; }
    state.time += dt;

    ensureScene();
    const TH = T();
    if (!TH) {
      const ctx = host.ctx; const canvas = host.canvas;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#05060b'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffd76a'; ctx.font = 'bold 48px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('Loading 3D engine…', canvas.width / 2, canvas.height / 2);
      return;
    }

    // read hand input for bat position / bowl aim
    const blades = h.pointers.blades();
    let bx = 0.5, by = 0.5, maxSpeed = 0;
    for (const b of blades) {
      // map world coords (0..1920) to normalized
      const nx = clamp(b.x / WORLD.w, 0, 1);
      const ny = clamp(b.y / WORLD.h, 0, 1);
      bx = nx; by = ny;
      if (b.speed > maxSpeed) maxSpeed = b.speed;
    }
    handX = handX * 0.7 + bx * 0.3;
    handY = handY * 0.7 + by * 0.3;

    if (state.phase === 'batting') {
      // bat follows hand
      batTargetX = (handX - 0.5) * 2.4;
      batTargetY = 0.9 + (1 - handY) * 1.2;
      if (bat) {
        bat.position.x += (batTargetX - bat.position.x) * 0.25;
        bat.position.y += (batTargetY - bat.position.y) * 0.25;
      }
      // swing detection
      if (!batSwinging && swingCooldown <= 0) {
        for (const b of blades) {
          if (b.speed > 500 && Math.abs(b.vx) > 250) {
            batSwinging = true; batSwing = 0; swingCooldown = 0.5;
            lastSwingSpeed = b.speed;
            if (ballState === 'bowling' && ballPos.z > 4 && ballPos.z < 12) tryHit(h);
            break;
          }
        }
      }
      if (batSwinging) {
        batSwing += dt * 10;
        if (batSwing >= 1) { batSwing = 1; batSwinging = false; }
      } else if (batSwing > 0) {
        batSwing = Math.max(0, batSwing - dt * 5);
      }
      if (bat) {
        bat.rotation.x = -Math.PI / 2 + batSwing * Math.PI * 1.15;
        bat.rotation.z = (handX - 0.5) * 0.6;
      }

      // bowler animation
      if (bowler && ballState === 'bowling') {
        bowler.position.z = -9 + (ballPos.z + 9) * 0.35;
        bowler.position.z = Math.min(bowler.position.z, -7.5);
      } else if (bowler) {
        bowler.position.z = -9;
      }

      // bowl timer / ball flight
      if (ballState === 'idle') {
        bowlTimer -= dt;
        if (bowlTimer <= 0) bowl();
      } else if (ballState === 'bowling') {
        ballVel.y -= 9.8 * dt;
        if (ballPos) ballPos.addScaledVector(ballVel, dt);
        if (ball && ballPos) ball.position.copy(ballPos);
        if (ball) ball.rotation.x += dt * 14;
        if (Math.abs(ballPos.z - 9) < 2.2 && !hitWindow) { hitWindow = true; hitTime = 0; }
        if (hitWindow) hitTime += dt;
        if (ballPos.z > 11) {
          ballState = 'done';
          if (!batSwinging) {
            if (Math.random() < 0.4) wicket('bowled'); else dotBall();
          }
          ball.visible = false;
          scheduleNext('batting');
        }
      }

    } else if (state.phase === 'bowling') {
      // player bowls: aim with hand X, swing to deliver
      bowlAim = (handX - 0.5) * 2;
      if (bat) { bat.position.x = 0.4; bat.position.y = 1.0; bat.rotation.x = -Math.PI / 2; batSwing = 0; }
      if (batsman) batsman.position.z = 9;

      // detect swing to deliver
      if (ballState === 'idle' && !bowlCharging) {
        for (const b of blades) {
          if (b.speed > 400) {
            bowlCharging = true; bowlPower = clamp(b.speed / 1200, 0.3, 1.0);
            bowl(); break;
          }
        }
      }

      if (ballState === 'bowling') {
        ballVel.y -= 9.8 * dt;
        if (ballPos) ballPos.addScaledVector(ballVel, dt);
        if (ball && ballPos) ball.position.copy(ballPos);
        if (ball) ball.rotation.x += dt * 14;
        // when ball reaches batsman (z ~ 9), AI plays
        if (ballPos.z > 8 && ballPos.z < 10 && !hitWindow) {
          hitWindow = true;
          // AI batsman decision
          const onTarget = Math.abs(ballPos.x) < 0.35;
          const speed = Math.hypot(ballVel.x, ballVel.z);
          if (onTarget && Math.random() < 0.5) {
            // wicket (bowled or caught)
            if (Math.random() < 0.6) {
              state.oppWickets = Math.min(10, state.oppWickets + 1);
              resultText = 'WICKET!';
              host?.effects?.flash('#ff2f4f', 0.3);
              host?.audio?.playStrike();
            } else {
              const r = [1,2,4][Math.floor(Math.random()*3)];
              state.oppRuns += r; resultText = `${r} RUNS`;
              host?.audio?.playSlice(1);
            }
          } else {
            const r = Math.random() < 0.3 ? 0 : [1,2,4][Math.floor(Math.random()*3)];
            state.oppRuns += r;
            resultText = r === 0 ? 'DOT' : `${r} RUNS`;
            if (r > 0) host?.audio?.playSlice(0.9);
          }
          resultTimer = 1.2;
          state.oppBalls++;
          if (state.oppBalls % 6 === 0) state.overs = Math.min(state.maxOvers, state.overs + 1);
          state.balls = state.oppBalls;
          host?.emit('hud', state);
        }
        if (ballPos.z > 11) {
          ballState = 'done'; ball.visible = false;
          scheduleNext('bowling');
        }
      }

      if (ballState === 'idle') {
        bowlTimer -= dt;
        if (bowlTimer <= 0) bowl();
      }
    }

    // result timer
    if (resultTimer > 0) resultTimer -= dt;

    // phase transition: batting done after maxOvers overs or 10 wickets
    if (state.phase === 'batting' && (state.balls >= state.maxOvers * 6 || state.wickets >= 10)) {
      state.phase = 'bowling';
      state.balls = 0; state.overs = 0;
      bowlTimer = 1.5; ballState = 'idle';
      resultText = 'NOW BOWL!'; resultTimer = 2.0;
      host?.effects?.flash('#a9f4ff', 0.4);
    }
    // bowling done
    if (state.phase === 'bowling' && (state.oppBalls >= state.maxOvers * 6 || state.oppWickets >= 10)) {
      if (gameOverTimer === 0) {
        gameOverTimer = 2.0;
        state.running = false;
        host?.audio?.duck(true);
        const won = state.runs > state.oppRuns;
        host?.emit('gameover', {
          reason: won ? 'win' : 'loss',
          score: state.runs,
          sliced: state.balls + state.oppBalls,
          maxCombo: state.maxCombo,
          missed: state.wickets + state.oppWickets,
          time: Math.round(state.time),
        });
      }
    }

    renderScene();
  }

  function tryHit(h) {
    const timeToContact = (9 - ballPos.z) / (ballVel.z || 1);
    const err = Math.abs(timeToContact);
    let runs = 0, label = '';
    if (err < 0.08) { runs = 6; label = 'SIX!'; h.audio?.playCombo(6); }
    else if (err < 0.2) { runs = 4; label = 'FOUR!'; h.audio?.playCombo(4); }
    else if (err < 0.4) { runs = 2; label = '2 RUNS'; h.audio?.playSlice(1.2); }
    else { runs = 1; label = '1 RUN'; h.audio?.playSlice(0.9); }

    if (runs >= 4 && Math.random() < 0.12) {
      runs = 0; label = 'CAUGHT!';
      wicket('caught');
    } else if (runs > 0) {
      state.runs += runs; state.score = state.runs; state.sliced++;
      state.combo = state.comboTimer > 0 ? state.combo + 1 : 1;
      state.comboTimer = 0.5;
      state.maxCombo = Math.max(state.maxCombo, state.combo);
      h.effects.juice(WORLD.w / 2, WORLD.h / 2, ['#ffd76a', '#fff', '#ff9d1c'], 24, 1.2);
      h.effects.popup(WORLD.w / 2, WORLD.h * 0.3, label, { color: runs >= 4 ? '#ffd76a' : '#fff6df', size: runs >= 6 ? 80 : 56, life: 1.2 });
      if (runs >= 4) h.effects.shockwave(WORLD.w / 2, WORLD.h / 2, '#ffd76a', 300, 14);
      h.emit('slice', { type: 'cricket', points: runs, combo: state.combo, x: 0, y: 0, speed: lastSwingSpeed });
    } else if (label === 'CAUGHT!') {
      h.effects.flash('#ff2f4f', 0.3);
      h.effects.popup(WORLD.w / 2, WORLD.h * 0.3, label, { color: '#ff7b8a', size: 72, life: 1.2 });
      h.emit('miss', { lives: 10 - state.wickets });
    }
    resultText = label; resultTimer = 1.4;
    ballState = 'done'; ball.visible = false;
    scheduleNext('batting');
  }

  function wicket(kind) {
    state.wickets++;
    state.missed++;
    state.combo = 0; state.comboTimer = 0;
    resultText = kind === 'bowled' ? 'BOWLED!' : 'CAUGHT!';
    resultTimer = 1.4;
    host?.effects?.flash('#ff2f4f', 0.25);
    host?.effects?.shakeScreen(12, 0.3);
    host?.audio?.playStrike();
    host?.effects?.popup(WORLD.w / 2, WORLD.h * 0.3, resultText, { color: '#ff7b8a', size: 72, life: 1.2 });
    host?.emit('miss', { lives: 10 - state.wickets });
  }

  function dotBall() {
    resultText = 'DOT BALL'; resultTimer = 1.0;
    host?.audio?.playSlice(0.6);
  }

  function scheduleNext(phase) {
    state.balls++;
    if (state.balls % 6 === 0) state.overs = Math.min(state.maxOvers, state.overs + 1);
    ballState = 'idle';
    bowlTimer = (phase === 'bowling') ? rand(1.0, 1.5) : rand(1.2, 1.8);
    hitWindow = false; hitTime = 0;
    batSwinging = false; batSwing = 0; swingCooldown = 0;
    bowlCharging = false; bowlPower = 0;
  }

  function renderScene() {
    if (!renderer || !scene || !camera) return;
    const t = (performance.now() / 1000) - t0;
    camera.position.x = Math.sin(t * 0.2) * 0.4;
    camera.position.y = 9 + Math.sin(t * 0.3) * 0.15;
    camera.lookAt(0, 1, 0);
    renderer.render(scene, camera);
    updateResultOverlay();
  }

  function updateResultOverlay() {
    let el = document.getElementById('cricket-result');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cricket-result';
      el.style.cssText = 'position:fixed;left:50%;top:18%;transform:translateX(-50%);z-index:5;font-size:3.5rem;font-weight:900;letter-spacing:0.05em;text-shadow:0 4px 20px rgba(0,0,0,0.7);pointer-events:none;transition:opacity 0.3s;white-space:nowrap;';
      document.body.appendChild(el);
    }
    // phase indicator
    let phaseEl = document.getElementById('cricket-phase');
    if (!phaseEl) {
      phaseEl = document.createElement('div');
      phaseEl.id = 'cricket-phase';
      phaseEl.style.cssText = 'position:fixed;left:50%;top:8%;transform:translateX(-50%);z-index:5;font-size:1.2rem;font-weight:800;letter-spacing:0.2em;color:rgba(255,246,233,0.8);text-shadow:0 2px 8px rgba(0,0,0,0.6);pointer-events:none;';
      document.body.appendChild(phaseEl);
    }
    phaseEl.textContent = state.phase === 'batting' ? 'BATTING' : state.phase === 'bowling' ? 'BOWLING' : 'RESULT';
    if (resultTimer > 0 && resultText) {
      el.textContent = resultText;
      el.style.opacity = '1';
      const color = resultText.includes('SIX') || resultText.includes('FOUR') || resultText.includes('RUN') ? '#ffd76a' : (resultText.includes('WICKET') || resultText.includes('CAUGHT') || resultText.includes('BOWLED')) ? '#ff7b8a' : '#fff6df';
      el.style.color = color;
    } else {
      el.style.opacity = '0';
    }
    // score bug
    let bug = document.getElementById('cricket-scorebug');
    if (!bug) {
      bug = document.createElement('div');
      bug.id = 'cricket-scorebug';
      bug.style.cssText = 'position:fixed;right:2rem;top:2rem;z-index:5;background:rgba(8,6,14,0.7);border:1px solid rgba(255,255,255,0.15);border-radius:1rem;padding:0.8rem 1.2rem;font-weight:800;letter-spacing:0.05em;backdrop-filter:blur(8px);pointer-events:none;';
      document.body.appendChild(bug);
    }
    bug.innerHTML = state.phase === 'batting'
      ? `<div style="font-size:0.8rem;opacity:0.6">BATTING</div><div style="font-size:2rem;color:#ffd76a">${state.runs}/${state.wickets}</div><div style="font-size:0.85rem;opacity:0.7">${state.overs}.${state.balls % 6} ov</div>`
      : `<div style="font-size:0.8rem;opacity:0.6">BOWLING</div><div style="font-size:2rem;color:#a9f4ff">${state.oppRuns}/${state.oppWickets}</div><div style="font-size:0.85rem;opacity:0.7">${state.overs}.${state.oppBalls % 6} ov</div><div style="font-size:0.75rem;opacity:0.5;margin-top:0.3rem">You: ${state.runs}</div>`;
  }

  function render(ctx, h) { /* Three.js renders in update */ }

  function isOver() { return !state.running && state.balls > 0 && (state.wickets >= 10 || state.balls >= state.maxOvers * 6 || state.phase !== 'batting'); }

  return {
    id: 'cricket', title: 'Cricket', state,
    init(h) { host = h; reset(); },
    start() { start(); },
    update(dt, h) { host = h; update(dt, h); },
    render(ctx, h) { render(ctx, h); },
    cleanup() { cleanup(); },
    isOver() { return !state.running && (state.balls > 0 || state.oppBalls > 0); },
    get mode() { return 'classic'; },
    get _debug() { return { ballState, phase: state.phase, bowlTimer, sceneReady: !!scene, sceneType: scene?.constructor?.name, ballExists: !!ball, batExists: !!bat, hasEnsureRun: window.__ensureRan }; },
  };
}

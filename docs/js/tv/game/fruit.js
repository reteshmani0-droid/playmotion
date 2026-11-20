/**
 * Fruit entities, slicing geometry and the wave spawner.
 * Pure simulation — no drawing, so the physics stays easy to tune and test.
 */
import { PHYSICS, WORLD, FRUIT_TYPES, BOMB, TYPE_WEIGHT_TOTAL, FRUIT_BY_ID } from './config.js';
import { rand, randInt, clamp } from '../../shared/util.js';

let nextId = 1;

export class Fruit {
  constructor(type, x, y, vx, vy) {
    this.id = nextId++;
    this.type = type;
    this.id_ = type.id;
    this.radius = type.radius;
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.rot = rand(0, Math.PI * 2);
    this.spin = rand(-2.6, 2.6);
    this.sliced = false;
    this.dead = false;
    this.scored = false;
    this.age = 0;
    this.apexDone = false;
    this.spawnedAt = 0;
    this.wobble = rand(0, 10);
    this.isBomb = type.id === 'bomb';
  }

  get isFalling() {
    return this.vy > 0;
  }

  update(dt, gravityMul = 1) {
    this.age += dt;
    this.vy += PHYSICS.gravity * gravityMul * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.rot += this.spin * dt;
    if (this.vy > 0) this.apexDone = true;
    // Missed fruit/bomb leaves the play field.
    if (this.y - this.radius > WORLD.h + 120) this.dead = true;
    if (this.x < -260 || this.x > WORLD.w + 260) this.dead = true;
  }
}

export class Half {
  constructor(fruit, side, sliceAngle, speed) {
    this.fruit = fruit;
    this.typeId = fruit.id_;
    this.radius = fruit.radius;
    this.side = side;
    this.x = fruit.x;
    this.y = fruit.y;
    this.rot = fruit.rot + sliceAngle + (side === 'b' ? Math.PI : 0);
    this.life = 0;
    this.alpha = 1;
    // Push the halves apart perpendicular to the cut.
    const nx = Math.cos(sliceAngle + Math.PI / 2);
    const ny = Math.sin(sliceAngle + Math.PI / 2);
    const dir = side === 'b' ? 1 : -1;
    const push = clamp(speed * 0.06, 90, 420);
    this.vx = fruit.vx + nx * push * dir + Math.cos(sliceAngle) * speed * 0.02;
    this.vy = fruit.vy + ny * push * dir + Math.sin(sliceAngle) * speed * 0.02 - 60;
    this.spin = (side === 'b' ? 1 : -1) * rand(1.6, 4.6);
    this.gravity = PHYSICS.gravity * 0.9;
  }

  update(dt) {
    this.life += dt;
    this.vy += this.gravity * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.rot += this.spin * dt;
    this.vx *= Math.pow(0.995, dt * 60);
    if (this.life > 2.2) this.alpha = Math.max(0, 1 - (this.life - 2.2) / 0.6);
  }

  get dead() {
    return this.alpha <= 0 || this.y - this.radius > WORLD.h + 200;
  }
}

/** Segment → circle intersection, used for blade-vs-fruit hit tests. */
export function segmentHitsCircle(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 1e-6) {
    t = ((cx - x1) * dx + (cy - y1) * dy) / len2;
    t = clamp(t, 0, 1);
  }
  const px = x1 + dx * t;
  const py = y1 + dy * t;
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/** Pick a fruit, weighted, optionally allowing bombs. */
export function pickFruitType(allowBomb, bombChance) {
  if (allowBomb && Math.random() < bombChance) return BOMB;
  let roll = Math.random() * TYPE_WEIGHT_TOTAL;
  for (const t of FRUIT_TYPES) {
    roll -= t.weight;
    if (roll <= 0) return t;
  }
  return FRUIT_TYPES[0];
}

/**
 * Wave spawner. Difficulty drives how often waves come, how many fruit they
 * contain and how likely a bomb is.
 */
export class Spawner {
  constructor() {
    this.reset();
  }

  reset() {
    this.timer = 1.1;
    this.pending = [];
    this.lastBombAt = -10;
    this.elapsed = 0;
    this.waves = 0;
    this.gravityMul = 1;
    this.speedMul = 1;
  }

  _scheduleWave(difficulty, allowBombs) {
    const count = randInt(difficulty.waveMin, difficulty.waveMax);
    const now = this.elapsed;
    for (let i = 0; i < count; i++) {
      const isBomb = allowBombs && now - this.lastBombAt > 1.6 && Math.random() < difficulty.bombChance;
      if (isBomb) this.lastBombAt = now;
      this.pending.push({
        at: now + i * rand(0.04, 0.22),
        type: isBomb ? BOMB : pickFruitType(false, 0),
        speedMul: difficulty.speedMul * rand(0.94, 1.06),
        aux: Math.random(),
      });
    }
    this.waves++;
  }

  /**
   * @param {number} dt
   * @param {ReturnType<import('./config.js').difficultyAt>} difficulty
   * @param {{practice?:boolean, allowBombs?:boolean, onSpawn:(fruit:Fruit)=>void}} cb
   */
  update(dt, difficulty, cb) {
    this.elapsed += dt;
    this.gravityMul = difficulty.gravityMul;
    this.speedMul = difficulty.speedMul;

    this.timer -= dt;
    if (this.timer <= 0 && this.pending.length === 0) {
      if (cb.practice) {
        this.pending.push({ at: this.elapsed, type: pickFruitType(false, 0), speedMul: 0.72, aux: Math.random() });
        this.timer = 1.35;
      } else {
        this._scheduleWave(difficulty, cb.allowBombs !== false);
        this.timer = difficulty.spawnInterval * rand(0.86, 1.16);
      }
    }

    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (p.at > this.elapsed) continue;
      this.pending.splice(i, 1);
      cb.onSpawn(this._makeFruit(p, cb.practice));
    }
  }

  _makeFruit(p, practice = false) {
    const type = p.type;
    const margin = 210;
    // Fruits aim to peak across the middle band of the screen.
    const x = rand(margin, WORLD.w - margin);
    const apexY = WORLD.h * (practice ? rand(0.34, 0.55) : rand(PHYSICS.minApex, PHYSICS.maxApex));
    const g = PHYSICS.gravity * this.gravityMul * (practice ? 0.72 : 1);
    const dist = PHYSICS.spawnY - apexY;
    const vy = -Math.sqrt(2 * g * dist) * (practice ? 1 : this.speedMul);
    const flight = Math.abs(vy / g) * 1.55;
    const targetX = WORLD.w / 2 + (x - WORLD.w / 2) * -0.35 + rand(-120, 120);
    const vx = clamp(((targetX - x) / flight) * 0.9 + rand(-50, 50), PHYSICS.minVx, PHYSICS.maxVx);
    const f = new Fruit(type, x, PHYSICS.spawnY, vx, vy);
    f.spawnedAt = this.elapsed;
    return f;
  }
}

export function fruitJuiceColors(id) {
  return FRUIT_BY_ID[id]?.juice || ['#ff5a52', '#ffd9a0', '#ffffff'];
}

export function fruitScore(id) {
  return FRUIT_BY_ID[id]?.score || 0;
}

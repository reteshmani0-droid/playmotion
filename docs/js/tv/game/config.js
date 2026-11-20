/**
 * Gameplay tuning + fruit definitions.
 * All positions/sizes are in the game's logical 1920×1080 space.
 */

export const WORLD = { w: 1920, h: 1080 };

export const PHYSICS = {
  gravity: 1680,          // px/s²
  spawnY: 1140,           // just below the screen
  minApex: 0.16,          // highest point as a fraction of screen height
  maxApex: 0.46,
  minVx: -190,
  maxVx: 190,
  bombGravity: 1620,
};

export const FRUIT_TYPES = [
  {
    id: 'apple', label: 'Apple', radius: 56, score: 12, weight: 18,
    juice: ['#ff5a52', '#e12638', '#ffd9a0'],
  },
  {
    id: 'orange', label: 'Orange', radius: 56, score: 12, weight: 17,
    juice: ['#ffb13b', '#ff8a1f', '#ffe6a8'],
  },
  {
    id: 'watermelon', label: 'Watermelon', radius: 78, score: 20, weight: 12,
    juice: ['#ff3d68', '#ff7ba6', '#39a94b'],
  },
  {
    id: 'banana', label: 'Banana', radius: 62, score: 14, weight: 14,
    juice: ['#ffe066', '#f7c948', '#fff7d6'],
  },
  {
    id: 'strawberry', label: 'Strawberry', radius: 48, score: 10, weight: 17,
    juice: ['#ff3b52', '#e01033', '#ffe1e4'],
  },
  {
    id: 'pineapple', label: 'Pineapple', radius: 68, score: 16, weight: 11,
    juice: ['#ffd84d', '#f2b705', '#8fd14f'],
  },
];

export const BOMB = {
  id: 'bomb', label: 'Bomb', radius: 56, score: 0, weight: 1,
  juice: ['#4a4f58', '#ffb03a', '#ff5a1f'],
};

export const FRUIT_BY_ID = Object.fromEntries([...FRUIT_TYPES, BOMB].map((f) => [f.id, f]));

export const TYPE_WEIGHT_TOTAL = FRUIT_TYPES.reduce((s, f) => s + f.weight, 0);

export const RULES = {
  lives: 3,
  comboWindow: 0.55,      // seconds to chain slices into one combo
  comboMin: 2,
  comboBonus: 15,         // per fruit beyond the first, scaled by combo size
  bombEndsGame: true,
  practiceFruitCount: 3,
};

/**
 * Classic-mode difficulty curve. Ramps for ~3 minutes then plateaus.
 * @param {number} elapsed seconds since the round started
 */
export function difficultyAt(elapsed) {
  const t = Math.min(1, elapsed / 165);
  const eased = t * t * (3 - 2 * t);
  return {
    t: eased,
    spawnInterval: 1.12 - 0.5 * eased,     // seconds between waves
    waveMin: 1,
    waveMax: 1 + Math.round(eased * 2.4),  // up to 3-4 fruit per wave
    bombChance: 0.03 + 0.14 * eased,
    speedMul: 0.94 + 0.22 * eased,
    gravityMul: 1 + 0.05 * eased,
  };
}

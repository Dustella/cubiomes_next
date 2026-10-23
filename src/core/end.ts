// End island height field (the `minecraft:end_islands` density function) and
// the End biome source thresholds, which are code rather than data in-game.

import { GRADIENTS, ImprovedNoise } from './noise';
import { LegacyRandom } from './rng';

const SKEW = 0.5 * (Math.sqrt(3) - 1);
const UNSKEW = (3 - Math.sqrt(3)) / 6;
const f = Math.fround;

/** 2D simplex noise over an ImprovedNoise permutation table (offsets unused). */
export function simplex2(perm: Uint8Array, x: number, y: number): number {
  const s = (x + y) * SKEW;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * UNSKEW;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = 1 - i1;
  const x1 = x0 - i1 + UNSKEW, y1 = y0 - j1 + UNSKEW;
  const x2 = x0 - 1 + 2 * UNSKEW, y2 = y0 - 1 + 2 * UNSKEW;
  const p = (k: number): number => perm[k & 255]!;
  const corner = (g: number, cx: number, cy: number): number => {
    let c = 0.5 - cx * cx - cy * cy;
    if (c < 0) return 0;
    c *= c;
    const v = GRADIENTS[g]!;
    return c * c * (v[0] * cx + v[1] * cy);
  };
  return 70 * (
    corner(p(i + p(j)) % 12, x0, y0) +
    corner(p(i + i1 + p(j + j1)) % 12, x1, y1) +
    corner(p(i + 1 + p(j + 1)) % 12, x2, y2));
}

export class EndIslands {
  readonly perm: Uint8Array;

  constructor(seed: bigint) {
    const r = new LegacyRandom(seed);
    r.consume(17292);
    this.perm = new ImprovedNoise(r).perm;
  }

  /**
   * Island height at 8-block cell coordinates, in float like the game.
   * Far out, cx*cx + cz*cz overflows int and goes negative; sqrt then yields
   * NaN, which Java's clamp (min/max) propagates and later comparisons treat
   * as false. Math.min/max/`>` here have the same NaN semantics.
   */
  height(cx: number, cz: number): number {
    const hx = (cx / 2) | 0, hz = (cz / 2) | 0;
    const ox = cx % 2, oz = cz % 2;
    let best = f(100 - f(f(Math.sqrt(f((Math.imul(cx, cx) + Math.imul(cz, cz)) | 0))) * 8));
    best = Math.min(80, Math.max(-100, best));
    for (let i = -12; i <= 12; i++) {
      for (let j = -12; j <= 12; j++) {
        const rx = hx + i, rz = hz + j;
        if (rx * rx + rz * rz <= 4096 || simplex2(this.perm, rx, rz) >= f(-0.9)) continue;
        const size = f(f(f(f(Math.abs(rx)) * 3439) + f(f(Math.abs(rz)) * 147)) % 13 + 9);
        const dx = f(ox - i * 2), dz = f(oz - j * 2);
        let h = f(100 - f(f(Math.sqrt(f(f(dx * dx) + f(dz * dz)))) * size));
        h = Math.min(80, Math.max(-100, h));
        if (h > best) best = h;
      }
    }
    return best;
  }

  /** Value of the `minecraft:end_islands` density function; Java int division truncates. */
  density(bx: number, bz: number): number {
    return (this.height(Math.trunc(bx / 8), Math.trunc(bz / 8)) - 8) / 128;
  }
}

/** End biome selection from the erosion density at a section centre. */
export function endBiome(qx: number, qz: number, erosionAt: (bx: number, bz: number) => number): string {
  const sx = (qx << 2) >> 4, sz = (qz << 2) >> 4;
  if (sx * sx + sz * sz <= 4096) return 'minecraft:the_end';
  const e = erosionAt((sx * 2 + 1) * 8, (sz * 2 + 1) * 8);
  if (e > 0.25) return 'minecraft:end_highlands';
  if (e >= -0.0625) return 'minecraft:end_midlands';
  if (e < -0.21875) return 'minecraft:small_end_islands';
  return 'minecraft:end_barrens';
}

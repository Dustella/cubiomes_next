// Gradient noise primitives matching Minecraft 1.18+ semantics.
// All arithmetic is IEEE double, like the game.

import { LegacyRandom, type RandomSource } from './rng';

export interface NoiseParams {
  firstOctave: number;
  amplitudes: number[];
}

/** Gradient vectors for hash & 15; index i -> [gx, gy, gz]. */
export const GRADIENTS: readonly (readonly [number, number, number])[] = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
  [1, 1, 0], [0, -1, 1], [-1, 1, 0], [0, -1, -1],
];

const smooth = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (t: number, a: number, b: number): number => a + t * (b - a);

/** One octave of improved Perlin noise with a random lattice offset. */
export class ImprovedNoise {
  readonly perm = new Uint8Array(256);
  readonly xo: number;
  readonly yo: number;
  readonly zo: number;

  constructor(r: RandomSource) {
    this.xo = r.nextDouble() * 256;
    this.yo = r.nextDouble() * 256;
    this.zo = r.nextDouble() * 256;
    const p = this.perm;
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 0; i < 256; i++) {
      const j = r.nextInt(256 - i);
      const t = p[i]!;
      p[i] = p[i + j]!;
      p[i + j] = t;
    }
  }

  noise(x: number, y: number, z: number): number {
    const dx = x + this.xo, dy = y + this.yo, dz = z + this.zo;
    const ix = Math.floor(dx), iy = Math.floor(dy), iz = Math.floor(dz);
    return this.sampleLattice(ix, iy, iz, dx - ix, dy - iy, dz - iz);
  }

  /** Samples lattice cell (ix,iy,iz) at fractional offsets in [0,1). */
  sampleLattice(ix: number, iy: number, iz: number, fx: number, fy: number, fz: number): number {
    const p = this.perm;
    const a = p[ix & 255]!, b = p[(ix + 1) & 255]!;
    const aa = p[(a + iy) & 255]!, ab = p[(a + iy + 1) & 255]!;
    const ba = p[(b + iy) & 255]!, bb = p[(b + iy + 1) & 255]!;
    const g = (h: number, x: number, y: number, z: number): number => {
      const v = GRADIENTS[h & 15]!;
      return v[0] * x + v[1] * y + v[2] * z;
    };
    const n000 = g(p[(aa + iz) & 255]!, fx, fy, fz);
    const n100 = g(p[(ba + iz) & 255]!, fx - 1, fy, fz);
    const n010 = g(p[(ab + iz) & 255]!, fx, fy - 1, fz);
    const n110 = g(p[(bb + iz) & 255]!, fx - 1, fy - 1, fz);
    const n001 = g(p[(aa + iz + 1) & 255]!, fx, fy, fz - 1);
    const n101 = g(p[(ba + iz + 1) & 255]!, fx - 1, fy, fz - 1);
    const n011 = g(p[(ab + iz + 1) & 255]!, fx, fy - 1, fz - 1);
    const n111 = g(p[(bb + iz + 1) & 255]!, fx - 1, fy - 1, fz - 1);
    const sx = smooth(fx), sy = smooth(fy), sz = smooth(fz);
    return lerp(sz,
      lerp(sy, lerp(sx, n000, n100), lerp(sx, n010, n110)),
      lerp(sy, lerp(sx, n001, n101), lerp(sx, n011, n111)));
  }
}

/** Keeps coordinates within the range where doubles retain sub-block precision. */
export const wrap = (v: number): number => v - Math.floor(v / 33554432 + 0.5) * 33554432;

export interface Octave {
  noise: ImprovedNoise;
  /** Input multiplier (2^octave). */
  inputFactor: number;
  /** amplitude[i] * per-octave value factor. */
  weight: number;
}

/** Sum of octaves; octaves with zero amplitude are absent. */
export class PerlinNoise {
  constructor(readonly octaves: Octave[]) {}

  static create(r: RandomSource, p: NoiseParams): PerlinNoise {
    const len = p.amplitudes.length;
    const pos = r.forkPositional();
    const octaves: Octave[] = [];
    let inputFactor = 2 ** p.firstOctave;
    let valueFactor = 2 ** (len - 1) / (2 ** len - 1);
    for (let i = 0; i < len; i++, inputFactor *= 2, valueFactor /= 2) {
      const amp = p.amplitudes[i]!;
      if (amp === 0) continue;
      octaves.push({ noise: new ImprovedNoise(pos.fromHashOf(`octave_${p.firstOctave + i}`)), inputFactor, weight: amp * valueFactor });
    }
    return new PerlinNoise(octaves);
  }

  /**
   * Legacy sequential octave seeding (pre-1.18 style), still used by legacy
   * random sources: octaves above the highest requested one are skipped, then
   * octaves are drawn from highest to lowest frequency.
   */
  static createLegacy(r: LegacyRandom, p: NoiseParams): PerlinNoise {
    const len = p.amplitudes.length;
    const highest = p.firstOctave + len - 1;
    if (highest > 0) throw new Error('legacy noise with positive octaves is unsupported');
    r.consume(-highest * 262);
    const levels: (ImprovedNoise | null)[] = new Array(len).fill(null);
    for (let i = len - 1; i >= 0; i--) {
      if (p.amplitudes[i] !== 0) levels[i] = new ImprovedNoise(r);
      else r.consume(262);
    }
    const octaves: Octave[] = [];
    let inputFactor = 2 ** p.firstOctave;
    let valueFactor = 2 ** (len - 1) / (2 ** len - 1);
    for (let i = 0; i < len; i++, inputFactor *= 2, valueFactor /= 2) {
      const n = levels[i];
      if (n) octaves.push({ noise: n, inputFactor, weight: p.amplitudes[i]! * valueFactor });
    }
    return new PerlinNoise(octaves);
  }

  sample(x: number, y: number, z: number): number {
    let v = 0;
    for (const o of this.octaves) {
      v += o.weight * o.noise.noise(wrap(x * o.inputFactor), wrap(y * o.inputFactor), wrap(z * o.inputFactor));
    }
    return v;
  }
}

/** Second-sampler coordinate stretch, decorrelates the two octave sets. */
export const NORMAL_B_FACTOR = 1.0181268882175227;

/** Two perlin sums normalised to roughly unit deviation. */
export class NormalNoise {
  readonly valueFactor: number;

  constructor(readonly a: PerlinNoise, readonly b: PerlinNoise, p: NoiseParams) {
    let lo = Infinity, hi = -Infinity;
    p.amplitudes.forEach((v, i) => {
      if (v !== 0) { lo = Math.min(lo, i); hi = Math.max(hi, i); }
    });
    const span = hi - lo;
    this.valueFactor = hi < lo ? 0 : (1 / 6) / (0.1 * (1 + 1 / (span + 1)));
  }

  static create(r: RandomSource, p: NoiseParams): NormalNoise {
    return new NormalNoise(PerlinNoise.create(r, p), PerlinNoise.create(r, p), p);
  }

  static createLegacy(r: LegacyRandom, p: NoiseParams): NormalNoise {
    return new NormalNoise(PerlinNoise.createLegacy(r, p), PerlinNoise.createLegacy(r, p), p);
  }

  sample(x: number, y: number, z: number): number {
    const f = NORMAL_B_FACTOR;
    return (this.a.sample(x, y, z) + this.b.sample(x * f, y * f, z * f)) * this.valueFactor;
  }
}

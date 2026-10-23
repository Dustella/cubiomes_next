// Clean-room standard-dimension biome sampling, derived from Cubiomes
// biomenoise.c/noise.c (MIT, Copyright (c) 2020 Cubitect). No game sources.
// Quart coordinates are the native 1:4 biome grid; height is unused in both dimensions.
import { simplex2, EndIslands } from '../core/end';
import { ImprovedNoise, wrap } from '../core/noise';
import { LegacyRandom } from '../core/rng';
import type { Region } from '../gpu/runner';

export type StandardDimension = 'nether' | 'end';
const f = Math.fround;

export function validateStandardDimension(version: number, dimension: StandardDimension): void {
  if (!Number.isInteger(version) || version < 3 || version > 27) throw new RangeError('Unsupported Cubiomes release version');
  if (dimension !== 'nether' && dimension !== 'end') throw new RangeError('Unsupported standard dimension');
}
const POINTS = [
  [0, 0, 0, 8],
  [0, -0.5, 0, 170],
  [f(0.4), 0, 0, 171],
  [0, 0.5, f(0.375 * 0.375), 172],
  [-0.5, 0, f(0.175 * 0.175), 173],
] as const;

/** Cubiomes' high-to-low octave order matters for the double sum. */
export class NetherNoise {
  readonly octaves: ImprovedNoise[] = [];

  constructor(seed: bigint) {
    const r = new LegacyRandom(seed);
    for (let part = 0; part < 2; part++) {
      r.consume(6 * 262);
      this.octaves.push(new ImprovedNoise(r), new ImprovedNoise(r));
    }
  }

  sample(x: number, z: number): number {
    let a = 0, b = 0;
    for (let i = 0; i < 2; i++) {
      const scale = 2 ** (-6 - i);
      const weight = (2 ** i) / 3;
      a += weight * this.octaves[i]!.noise(wrap(x * scale), 0, wrap(z * scale));
      const stretch = 337 / 331;
      b += weight * this.octaves[i + 2]!.noise(wrap(x * stretch * scale), 0, wrap(z * stretch * scale));
    }
    return (a + b) * ((10 / 6) * 2 / 3);
  }
}

/** Strict '<' keeps the first climate point on a tie, as in getNetherBiome(). */
export function netherBiome(temperature: number, humidity: number): number {
  temperature = f(temperature);
  humidity = f(humidity);
  let best = Infinity, biome = 8;
  for (const p of POINTS) {
    const dx = f(p[0] - temperature), dz = f(p[1] - humidity);
    const distance = f(f(f(dx * dx) + f(dz * dz)) + p[2]);
    if (distance < best) { best = distance; biome = p[3]; }
  }
  return biome;
}

/** Integer height-threshold form of Cubiomes mapEndBiome(), including far rings. */
export function sampleEnd(perm: Uint8Array, version: number, qx: number, qz: number): number {
  const chunkX = qx >> 2, chunkZ = qz >> 2;
  if (chunkX * chunkX + chunkZ * chunkZ <= 4096) return 9;
  const hx = chunkX * 2 + 1, hz = chunkZ * 2 + 1;
  if (version > 16 && ((Math.imul(hx, hx) + Math.imul(hz, hz)) | 0) < 0) return 43;
  const centerX = Math.trunc(hx / 2), centerZ = Math.trunc(hz / 2);
  const ox = hx % 2, oz = hz % 2;
  let heightSquared = 14401;
  for (let j = -12; j <= 12; j++) {
    const rz = centerZ + j;
    const dz = oz - 2 * j;
    for (let i = -12; i <= 12; i++) {
      const rx = centerX + i;
      if (rx * rx + rz * rz <= 4096 || simplex2(perm, rx, rz) >= f(-0.9)) continue;
      // Cubiomes casts the rounded float sum to unsigned before taking % 13.
      const size = ((f(f(f(Math.abs(rx)) * 3439) + f(f(Math.abs(rz)) * 147)) >>> 0) % 13) + 9;
      const dx = ox - 2 * i;
      heightSquared = Math.min(heightSquared, (dx * dx + dz * dz) * size * size);
    }
  }
  return heightSquared < 3600 ? 42 : heightSquared <= 10000 ? 41 : heightSquared <= 14400 ? 43 : 40;
}

export class StandardDimensionCpu {
  readonly temperature?: NetherNoise;
  readonly humidity?: NetherNoise;
  readonly end?: EndIslands;

  constructor(readonly version: number, readonly dimension: StandardDimension, readonly seed: bigint) {
    validateStandardDimension(version, dimension);
    if (seed < -(1n << 63n) || seed >= (1n << 63n)) throw new RangeError('Seed must be signed 64-bit');
    if (dimension === 'nether' && version >= 19) {
      this.temperature = new NetherNoise(seed);
      this.humidity = new NetherNoise(BigInt.asIntN(64, seed + 1n));
    } else if (dimension === 'end' && version >= 12) {
      this.end = new EndIslands(seed);
    }
  }

  biome(qx: number, _qy: number, qz: number): number {
    if (this.dimension === 'nether') {
      return this.temperature ? netherBiome(this.temperature.sample(qx, qz), this.humidity!.sample(qx, qz)) : 8;
    }
    return this.end ? sampleEnd(this.end.perm, this.version, qx, qz) : 9;
  }

  run(region: Region): Uint32Array {
    const out = new Uint32Array(region.w * region.h);
    for (let z = 0; z < region.h; z++) {
      for (let x = 0; x < region.w; x++) {
        out[z * region.w + x] = this.biome(region.x0 + x * region.step, region.qy, region.z0 + z * region.step);
      }
    }
    return out;
  }
}

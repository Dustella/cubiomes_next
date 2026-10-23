// Cubiomes-based 1.18--1.21.3 Overworld sampler (quart coordinates).
// Ported from MIT Cubiomes biomenoise.c: Copyright (c) 2020-2024 Cubitect.
// Local upstream and license: cubiomes-viewer/cubiomes/{biomenoise.c,LICENSE}.
// No game jars, official source, downloaded bundles, or CPU-generated GPU results.
import { NoiseSet } from '../core/evaluate';
import { boxDistance, quantize, type ClimateIndex } from '../core/climate';
import type { NormalNoise } from '../core/noise';
import { GpuBiomeRunner, type Region, type GpuResult } from '../gpu/runner';
import { assertModernVersion, modernBundle, modernIndex, modernModel, offsetSpline, sampleOffset } from './model';

const f = Math.fround;
const STRETCH = 337 / 331;
function assertSeed(seed: bigint): void {
  if (typeof seed !== 'bigint' || seed < -(1n << 63n) || seed >= (1n << 63n)) throw new RangeError('seed must be a signed 64-bit bigint');
}

/** Cubiomes uses a short rational amplitude table, not a recomputed floating
 * normalization formula. The octave implementation/RNG/permutations are shared. */
function sample(noise: NormalNoise, amplitude: number, x: number, y: number, z: number): number {
  return (noise.a.sample(x, y, z) + noise.b.sample(x * STRETCH, y * STRETCH, z * STRETCH)) * amplitude;
}

export class ModernCpu {
  private readonly shift: NormalNoise;
  private readonly temperature: NormalNoise;
  private readonly humidity: NormalNoise;
  private readonly continentalness: NormalNoise;
  private readonly erosion: NormalNoise;
  private readonly weirdness: NormalNoise;
  private readonly target = new Float64Array(7);
  private readonly splineValues = new Float64Array(4);
  private readonly index: ClimateIndex;
  // Early tables use fanout ten/five levels; later ones use six/six levels.
  private readonly searchStack = new Int32Array(64);

  constructor(readonly version: number, readonly seed: bigint, readonly largeBiomes = false) {
    assertModernVersion(version);
    assertSeed(seed);
    const bundle = modernBundle(version, largeBiomes);
    const noises = new NoiseSet(bundle, Object.keys(bundle.noise), seed, false);
    const suffix = largeBiomes ? '_large' : '';
    this.shift = noises.byId.get('minecraft:offset')!;
    this.temperature = noises.byId.get(`minecraft:temperature${suffix}`)!;
    this.humidity = noises.byId.get(`minecraft:vegetation${suffix}`)!;
    this.continentalness = noises.byId.get(`minecraft:continentalness${suffix}`)!;
    this.erosion = noises.byId.get(`minecraft:erosion${suffix}`)!;
    this.weirdness = noises.byId.get('minecraft:ridge')!;
    this.index = modernIndex(version);
  }

  /** Returns a reused seven-element buffer: six quantized climate axes and 0.
   * Float staging and spline lerp rounding follow sampleBiomeNoise/getSpline. */
  climate(qx: number, qy: number, qz: number): Float64Array {
    const px = qx + sample(this.shift, 15 / 12, qx, 0, qz) * 4;
    const pz = qz + sample(this.shift, 15 / 12, qz, qx, 0) * 4;
    const c = f(sample(this.continentalness, 45 / 30, px, 0, pz));
    const e = f(sample(this.erosion, 25 / 18, px, 0, pz));
    const w = f(sample(this.weirdness, 15 / 12, px, 0, pz));
    const v = this.splineValues;
    v[0] = c; v[1] = e;
    v[2] = f(-3 * f(Math.abs(f(Math.abs(w) - f(0.6666667))) - f(0.33333334)));
    v[3] = w;
    const offset = f(sampleOffset(offsetSpline, v) + f(0.015));
    const depth = f(1 - (qy * 4) / 128 - 83 / 160 + offset);
    const t = f(sample(this.temperature, 15 / 12, px, 0, pz));
    const h = f(sample(this.humidity, 10 / 9, px, 0, pz));
    const out = this.target;
    out[0] = quantize(t); out[1] = quantize(h); out[2] = quantize(c);
    out[3] = quantize(e); out[4] = quantize(depth); out[5] = quantize(w); out[6] = 0;
    return out;
  }

  /** Stateless tree search, matching sampleBiomeNoise(..., dat=NULL, flags=0).
   * No last-result cache: call order cannot change equal-distance tie results. */
  biome(qx: number, qy: number, qz: number): number {
    const target = this.climate(qx, qy, qz), index = this.index;
    const stack = this.searchStack;
    let top = 0, best = Infinity, entry = -1;
    stack[top++] = 0;
    while (top) {
      const node = stack[--top]!;
      const distance = boxDistance(index.bounds, node, target);
      if (distance >= best) continue;
      const child = index.child[node]!;
      if (child < 0) {
        best = distance; entry = ~child;
      } else {
        for (let i = index.count[node]! - 1; i >= 0; i--) stack[top++] = child + i;
      }
    }
    return index.entryBiome[entry]!;
  }

  run(r: Region): Uint32Array {
    const result = new Uint32Array(r.w * r.h);
    for (let z = 0; z < r.h; z++) {
      for (let x = 0; x < r.w; x++) result[z * r.w + x] = this.biome(r.x0 + x * r.step, r.qy, r.z0 + z * r.step);
    }
    return result;
  }
}

/** The compute shader evaluates shifted octave noise, the Cubiomes offset
 * spline, and the decoded Cubiomes climate tree on-device. Only RNG-derived
 * permutation tables are uploaded on setSeed(). GPU interpolation is f32;
 * unlike the CPU's double noise, boundary-adjacent results can differ. */
export class ModernGpu {
  private constructor(private readonly runner: GpuBiomeRunner) {}

  static async create(device: GPUDevice, version: number, largeBiomes = false): Promise<ModernGpu> {
    assertModernVersion(version);
    return new ModernGpu(await GpuBiomeRunner.create(device, modernModel(version, largeBiomes)));
  }

  setSeed(seed: bigint): void {
    assertSeed(seed);
    this.runner.setSeed(seed);
  }

  run(region: Region, withClimate = false): Promise<GpuResult> {
    return this.runner.run(region, withClimate);
  }

  destroy(): void {
    this.runner.destroy();
  }
}

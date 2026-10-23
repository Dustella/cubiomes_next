import type { Region } from '../gpu/runner';
import { ImprovedNoise } from '../core/noise';
import { LegacyRandom } from '../core/rng';
import { cell, type CellContext } from './kernel';
import { makeStack, planStack, seedStack, type Layer, type LayerArea } from './stack';

/** Quart-scale Overworld, Minecraft 1.0 through 1.17, Cubiomes numeric IDs. */
export class LegacyCpu {
  readonly layers: Layer[];
  private oceanNoise!: ImprovedNoise;
  private seed: bigint | null = null;
  constructor(readonly version: number, seed: bigint, readonly largeBiomes = false) {
    this.layers = makeStack(version, largeBiomes);
    this.setSeed(seed);
  }
  setSeed(seed: bigint): void {
    if (seed < -(1n << 63n) || seed >= 1n << 63n) throw new RangeError('Seed must be signed 64-bit');
    if (seed === this.seed) return;
    this.seed = seed;
    seedStack(this.layers, seed);
    this.oceanNoise = new ImprovedNoise(new LegacyRandom(seed));
  }
  biome(qx: number, _qy: number, qz: number): number {
    return this.run({ x0: qx, z0: qz, w: 1, h: 1, step: 1, qy: _qy })[0]!;
  }
  run(r: Region): Uint32Array {
    const result = new Uint32Array(r.w * r.h);
    const side = Math.max(1, Math.min(128, Math.floor(512 / r.step)));
    for (let tz = 0; tz < r.h; tz += side) {
      for (let tx = 0; tx < r.w; tx += side) {
        const tw = Math.min(side, r.w - tx), th = Math.min(side, r.h - tz);
        const rect = { x: r.x0 + tx * r.step, z: r.z0 + tz * r.step, w: (tw - 1) * r.step + 1, h: (th - 1) * r.step + 1 };
        const plan = planStack(this.layers, rect);
        const data = new Int32Array(plan.size);
        const sample = (area: LayerArea | undefined, x: number, z: number): number => area ? data[area.offset + x - area.x + (z - area.z) * area.w]! : 0;
        const context: CellContext = {
          mc: this.version, st: 0n, ss: 0n,
          a: () => 0, b: () => 0,
          noise: (x, z) => {
            const n = this.oceanNoise.noise(x / 8, z / 8, 0);
            return n > 0.4 ? 44 : n > 0.2 ? 45 : n < -0.4 ? 10 : n < -0.2 ? 46 : 0;
          },
        };
        for (let i = 0; i < this.layers.length; i++) {
          const area = plan.areas[i];
          if (!area) continue;
          const l = this.layers[i]!;
          context.st = l.st; context.ss = l.ss;
          context.a = (x, z) => sample(plan.areas[l.a], x, z);
          context.b = (x, z) => sample(plan.areas[l.b], x, z);
          for (let z = 0; z < area.h; z++) for (let x = 0; x < area.w; x++) {
            data[area.offset + x + z * area.w] = cell(context, l.op, area.x + x, area.z + z);
          }
        }
        const last = plan.areas[this.layers.length - 1]!;
        for (let z = 0; z < th; z++) for (let x = 0; x < tw; x++) {
          result[tx + x + (tz + z) * r.w] = data[last.offset + x * r.step + z * r.step * last.w]!;
        }
      }
    }
    return result;
  }
}

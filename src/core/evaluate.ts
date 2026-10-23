// Double-precision CPU evaluator for a DensityProgram. This is the reference
// implementation the GPU path is diffed against.

import type { LegacyNoiseOverride, WorldgenBundle } from './bundle';
import type { DensityProgram, Node, SplineIR } from './density';
import { EndIslands } from './end';
import { NormalNoise } from './noise';
import { LegacyRandom, Xoroshiro, type PositionalRandomFactory } from './rng';

const f = Math.fround;

/** Instantiated noises for one seed + random-source algorithm. */
export class NoiseSet {
  readonly byId = new Map<string, NormalNoise>();
  readonly endIslands: EndIslands;

  constructor(bundle: WorldgenBundle, ids: readonly string[], seed: bigint, legacy: boolean) {
    const factory: PositionalRandomFactory = legacy ? new LegacyRandom(seed).forkPositional() : Xoroshiro.fromSeed(seed).forkPositional();
    const overrides = legacy ? bundle.legacy_noise_overrides ?? DEFAULT_LEGACY_NOISE_OVERRIDES : {};
    for (const id of ids) {
      const o = overrides[id];
      const params = o?.noise ?? bundle.noise[id]!;
      let noise: NormalNoise;
      if (o?.zero) noise = NormalNoise.create(factory.fromHashOf(id), { firstOctave: 0, amplitudes: [0] });
      else if (o?.seed_offset !== undefined) noise = NormalNoise.createLegacy(new LegacyRandom(seed + BigInt(o.seed_offset)), params);
      else noise = NormalNoise.create(factory.fromHashOf(id), params);
      this.byId.set(id, noise);
    }
    this.endIslands = new EndIslands(seed);
  }
}

/**
 * Game-code behaviour of legacy-random-source settings (nether, end, caves,
 * floating islands), used when a bundle does not declare its own. Verified
 * against 1.21.4 (cubiomes oracle) and 26.2 (official jar) by tools/gt-diff.ts.
 */
export const DEFAULT_LEGACY_NOISE_OVERRIDES: Record<string, LegacyNoiseOverride> = {
  'minecraft:temperature': { seed_offset: 0, noise: { firstOctave: -7, amplitudes: [1, 1] } },
  'minecraft:vegetation': { seed_offset: 1, noise: { firstOctave: -7, amplitudes: [1, 1] } },
  'minecraft:offset': { zero: true },
  'minecraft:nether/temperature': { seed_offset: 0 },
  'minecraft:nether/vegetation': { seed_offset: 1 },
};

function splineValue(s: SplineIR, v: Float64Array): number {
  if (s.kind === 'const') return s.value;
  const x = f(v[s.coord]!);
  const locs = s.locations;
  const last = locs.length - 1;
  // Index of the last location <= x, or -1.
  let i = -1;
  while (i < last && x >= locs[i + 1]!) i++;
  if (i < 0 || i === last) {
    const k = i < 0 ? 0 : last;
    const base = splineValue(s.values[k]!, v);
    const d = s.derivatives[k]!;
    return d === 0 ? base : f(base + f(d * f(x - locs[k]!)));
  }
  const g = locs[i]!, h = locs[i + 1]!;
  const t = f(f(x - g) / f(h - g));
  const n = splineValue(s.values[i]!, v);
  const o = splineValue(s.values[i + 1]!, v);
  const span = f(h - g);
  const p = f(f(s.derivatives[i]! * span) - f(o - n));
  const q = f(f(f(-s.derivatives[i + 1]!) * span) + f(o - n));
  const lerpNO = f(n + f(t * f(o - n)));
  const lerpPQ = f(p + f(t * f(q - p)));
  return f(lerpNO + f(f(t * f(1 - t)) * lerpPQ));
}

function evalNode(n: Node, v: Float64Array, noises: NoiseSet, bx: number, by: number, bz: number): number {
  switch (n.op) {
    case 'const': return n.value;
    case 'y_linear': return n.offset + by * n.scale;
    case 'y_gradient': {
      const t = (by - n.fromY) / (n.toY - n.fromY);
      return t < 0 ? n.fromValue : t > 1 ? n.toValue : n.fromValue + t * (n.toValue - n.fromValue);
    }
    case 'unary': {
      const a = v[n.a]!;
      switch (n.fn) {
        case 'abs': return Math.abs(a);
        case 'square': return a * a;
        case 'cube': return a * a * a;
        case 'half_negative': return a > 0 ? a : a * 0.5;
        case 'quarter_negative': return a > 0 ? a : a * 0.25;
        case 'invert': return 1 / a;
        case 'squeeze': {
          const c = Math.min(1, Math.max(-1, a));
          return c / 2 - (c * c * c) / 24;
        }
      }
      throw new Error('unreachable');
    }
    case 'binary': {
      const a = v[n.a]!, b = v[n.b]!;
      switch (n.fn) {
        case 'add': return a + b;
        case 'mul': return a * b;
        case 'min': return Math.min(a, b);
        case 'max': return Math.max(a, b);
      }
      throw new Error('unreachable');
    }
    case 'clamp': return Math.min(n.max, Math.max(n.min, v[n.a]!));
    case 'range_choice': {
      const x = v[n.input]!;
      return x >= n.min && x < n.max ? v[n.inside]! : v[n.outside]!;
    }
    case 'noise':
      return noises.byId.get(n.noise)!.sample(bx * n.xzScale + v[n.sx]!, by * n.yScale + v[n.sy]!, bz * n.xzScale + v[n.sz]!);
    case 'shift': {
      const nn = noises.byId.get(n.noise)!;
      if (n.axes === 'a') return nn.sample(bx * 0.25, 0, bz * 0.25) * 4;
      if (n.axes === 'b') return nn.sample(bz * 0.25, bx * 0.25, 0) * 4;
      return nn.sample(bx * 0.25, by * 0.25, bz * 0.25) * 4;
    }
    case 'spline': return splineValue(n.spline, v);
    case 'end_islands': return noises.endIslands.density(bx, bz);
  }
}

/** Evaluates every node of `program` at one block position; returns the value buffer. */
export function evaluate(program: DensityProgram, noises: NoiseSet, bx: number, by: number, bz: number, out?: Float64Array): Float64Array {
  const v = out ?? new Float64Array(program.nodes.length);
  const nodes = program.nodes;
  for (let i = 0; i < nodes.length; i++) v[i] = evalNode(nodes[i]!, v, noises, bx, by, bz);
  return v;
}

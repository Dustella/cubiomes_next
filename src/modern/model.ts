// Clean-room adapter for MIT Cubiomes biomenoise.c and btree tables.
// Copyright (c) 2020-2024 Cubitect; see cubiomes-viewer/cubiomes/LICENSE.
// No official game sources or bundles are used by this module.
import data from './data';
import type { ClimateIndex } from '../core/climate';
import type { WorldgenBundle } from '../core/bundle';
import { DensityProgram, type Node, type SplineIR } from '../core/density';
import type { DimensionModel } from '../core/generator';

export type OffsetSpline = { value: number } | {
  axis: number; locations: number[]; derivatives: number[]; values: OffsetSpline[];
};
export const offsetSpline: OffsetSpline = data.spline;
const f = Math.fround;

export function assertModernVersion(mc: number): void {
  if (!Number.isInteger(mc) || mc < 22 || mc > 27) throw new RangeError(`Unsupported modern Overworld Cubiomes version: ${mc}`);
}

/** Cubiomes explicitly shares a table for 1.20.6, 1.21.1, and 1.21.3.
 * Its next table (btree21wd, pale garden) starts at 1.21.4 and is excluded. */
function treeName(mc: number): keyof typeof data.trees {
  assertModernVersion(mc);
  return mc >= 25 ? 'btree20' : mc >= 24 ? 'btree19' : mc >= 23 ? 'btree192' : 'btree18';
}
const indices = new Map<string, ClimateIndex>();

/** Decode Cubiomes' existing search tree; never rebuild/sort its leaves.
 * This retains the strict-distance tie ordering of climateToBiome(). */
export function modernIndex(mc: number): ClimateIndex {
  const name = treeName(mc);
  const previous = indices.get(name);
  if (previous) return previous;
  const source = data.trees[name];
  const rawNodes = source.nodes;
  const queue: { raw: number; depth: number }[] = [{ raw: 0, depth: 0 }];
  const bounds: number[] = [], child: number[] = [], count: number[] = [];
  const entryBiome: number[] = [], leafNode: number[] = [];
  for (let q = 0; q < queue.length; q++) {
    const { raw, depth } = queue[q]!;
    const hex = rawNodes[raw]!;
    for (let a = 0; a < 6; a++) {
      const p = Number.parseInt(hex.slice(14 - 2 * a, 16 - 2 * a), 16);
      bounds.push(source.params[p * 2]!, source.params[p * 2 + 1]!);
    }
    bounds.push(0, 0);
    if (source.steps[depth] === 0) {
      child.push(~entryBiome.length); count.push(0);
      entryBiome.push(Number.parseInt(hex.slice(2, 4), 16)); leafNode.push(q);
      continue;
    }
    let d = depth, step: number;
    do { step = source.steps[d++]!; } while (raw + step >= rawNodes.length);
    const inner = Number.parseInt(hex.slice(0, 4), 16);
    child.push(queue.length);
    let n = 0;
    for (; n < source.order && inner + n * step < rawNodes.length; n++) queue.push({ raw: inner + n * step, depth: d });
    count.push(n);
  }
  const result: ClimateIndex = {
    biomes: [], bounds: new Int32Array(bounds), child: new Int32Array(child), count: new Int32Array(count),
    entryBiome: new Int32Array(entryBiome), leafNode: new Int32Array(leafNode),
  };
  indices.set(name, result);
  return result;
}

/** getSpline(): float locals, but its lerp helper takes doubles. In particular,
 * rounding each lerp intermediate to float would not reproduce Cubiomes. */
export function sampleOffset(s: OffsetSpline, values: ArrayLike<number>): number {
  if ('value' in s) return f(s.value);
  const x = values[s.axis]!;
  let i = 0;
  while (i < s.locations.length && f(s.locations[i]!) < x) i++;
  if (i === 0 || i === s.locations.length) {
    if (i) i--;
    return f(sampleOffset(s.values[i]!, values) + f(f(s.derivatives[i]!) * f(x - f(s.locations[i]!))));
  }
  const g = f(s.locations[i - 1]!), h = f(s.locations[i]!);
  const k = f(f(x - g) / f(h - g));
  const n = sampleOffset(s.values[i - 1]!, values), o = sampleOffset(s.values[i]!, values);
  const p = f(f(f(s.derivatives[i - 1]!) * f(h - g)) - f(o - n));
  const q = f(f(-f(s.derivatives[i]!) * f(h - g)) + f(o - n));
  return f((n + k * (o - n)) + f(k * f(1 - k)) * (p + k * (q - p)));
}

export function modernBundle(mc: number, large: boolean): WorldgenBundle {
  assertModernVersion(mc);
  const suffix = large ? '_large' : '';
  return {
    format: 1, version: `cubiomes-${mc}${suffix}`, density_function: {}, noise_settings: {}, biome_parameters: {}, dimensions: {},
    noise: {
      'minecraft:offset': { firstOctave: -3, amplitudes: [1, 1, 1, 0] },
      [`minecraft:temperature${suffix}`]: { firstOctave: large ? -12 : -10, amplitudes: [1.5, 0, 1, 0, 0, 0] },
      [`minecraft:vegetation${suffix}`]: { firstOctave: large ? -10 : -8, amplitudes: [1, 1, 0, 0, 0, 0] },
      [`minecraft:continentalness${suffix}`]: { firstOctave: large ? -11 : -9, amplitudes: [1, 1, 2, 2, 2, 1, 1, 1, 1] },
      [`minecraft:erosion${suffix}`]: { firstOctave: large ? -11 : -9, amplitudes: [1, 1, 0, 1, 1] },
      'minecraft:ridge': { firstOctave: -7, amplitudes: [1, 2, 1, 0, 0, 0] },
    },
  };
}

const models = new Map<string, DimensionModel>();
/** Genuine backend-neutral climate IR: same shifted noises and offset spline
 * as Cubiomes, coupled to its decoded tree, not a post-1.21 bundle alias. */
export function modernModel(mc: number, large: boolean): DimensionModel {
  const key = `${mc}:${large}`;
  const hit = models.get(key);
  if (hit) return hit;
  const bundle = modernBundle(mc, large);
  const program = new DensityProgram(bundle);
  const add = (node: Node): number => { program.nodes.push(node); return program.nodes.length - 1; };
  const constant = (value: number): number => add({ op: 'const', value });
  const binary = (fn: 'add' | 'mul', a: number, b: number): number => add({ op: 'binary', fn, a, b });
  const zero = constant(0);
  const sx = add({ op: 'shift', noise: 'minecraft:offset', axes: 'a' });
  const sz = add({ op: 'shift', noise: 'minecraft:offset', axes: 'b' });
  const suffix = large ? '_large' : '';
  const noise = (name: string): number => add({ op: 'noise', noise: `minecraft:${name}`, xzScale: 0.25, yScale: 0, sx, sy: zero, sz });
  const c = noise(`continentalness${suffix}`), e = noise(`erosion${suffix}`), w = noise('ridge');
  const absW = add({ op: 'unary', fn: 'abs', a: w });
  const fold = add({ op: 'unary', fn: 'abs', a: binary('add', absW, constant(-f(0.6666667))) });
  const ridges = binary('mul', constant(-3), binary('add', fold, constant(-f(0.33333334))));
  const axis = [c, e, ridges, w];
  let splineId = 0;
  const convert = (s: OffsetSpline): SplineIR => 'value' in s ? { kind: 'const', value: f(s.value) } : {
    kind: 'multi', id: splineId++, coord: axis[s.axis]!, locations: s.locations.map(f), derivatives: s.derivatives.map(f), values: s.values.map(convert),
  };
  const offset = binary('add', add({ op: 'spline', spline: convert(offsetSpline) }), constant(f(0.015)));
  const height = add({ op: 'y_linear', scale: -1 / 128, offset: 1 - 83 / 160 });
  const depth = binary('add', height, offset);
  const t = noise(`temperature${suffix}`), h = noise(`vegetation${suffix}`);
  program.noises.push(...Object.keys(bundle.noise));
  // DimensionModel's constructor compiles JSON parameter lists. This adapter
  // already has compiled Cubiomes IR/tree, so it initializes the same public
  // model fields directly without inventing JSON or rebuilding the tree.
  const model: DimensionModel = {
    bundle, dimension: { settings: 'cubiomes:overworld', source: { type: 'multi_noise', parameters: 'cubiomes:overworld' } },
    program, roots: [t, h, c, e, depth, w], legacy: false, index: modernIndex(mc), biomes: [],
  };
  models.set(key, model);
  return model;
}

// Density-function JSON -> deduplicated IR DAG.
//
// The IR is backend-neutral: src/core/evaluate.ts runs it on the CPU in
// double precision, src/gpu/codegen.ts lowers it to WGSL. Nodes are appended
// in post-order, so iterating `nodes` front to back is a valid schedule.

import { qualify, type DensityJson, type WorldgenBundle } from './bundle';

export type UnaryOp = 'abs' | 'square' | 'cube' | 'half_negative' | 'quarter_negative' | 'squeeze' | 'invert';
export type BinaryOp = 'add' | 'mul' | 'min' | 'max';

export type SplineIR =
  | { kind: 'const'; value: number }
  | { kind: 'multi'; id: number; coord: number; locations: number[]; values: SplineIR[]; derivatives: number[] };

export type Node =
  | { op: 'const'; value: number }
  | { op: 'y_gradient'; fromY: number; toY: number; fromValue: number; toValue: number }
  /** Unclamped affine block-height term, used by the Cubiomes climate sampler. */
  | { op: 'y_linear'; scale: number; offset: number }
  | { op: 'unary'; fn: UnaryOp; a: number }
  | { op: 'binary'; fn: BinaryOp; a: number; b: number }
  | { op: 'clamp'; a: number; min: number; max: number }
  | { op: 'range_choice'; input: number; min: number; max: number; inside: number; outside: number }
  /** NormalNoise sampled at (bx*xz + sx, by*y + sy, bz*xz + sz). */
  | { op: 'noise'; noise: string; xzScale: number; yScale: number; sx: number; sy: number; sz: number }
  /** shift_a: (x/4, 0, z/4), shift_b: (z/4, x/4, 0), shift: (x/4, y/4, z/4); result * 4. */
  | { op: 'shift'; noise: string; axes: 'a' | 'b' | 'xyz' }
  | { op: 'spline'; spline: SplineIR }
  | { op: 'end_islands' };

/** Marker / blending wrappers that are identity when sampling single points outside chunk generation. */
const PASSTHROUGH = new Set(['flat_cache', 'cache_2d', 'cache_once', 'cache_all_in_cell', 'interpolated', 'blend_density']);
const UNARY = new Set<string>(['abs', 'square', 'cube', 'half_negative', 'quarter_negative', 'squeeze', 'invert']);
const BINARY = new Set<string>(['add', 'mul', 'min', 'max']);

export class DensityCompileError extends Error {}

export class DensityProgram {
  readonly nodes: Node[] = [];
  /** Noise ids referenced by any node, in first-use order. */
  readonly noises: string[] = [];
  splineCount = 0;
  private readonly byKey = new Map<string, number>();
  private readonly byRef = new Map<string, number>();
  private readonly resolving = new Set<string>();

  constructor(private readonly bundle: WorldgenBundle) {}

  /** Compiles a density function, returning its node index. */
  compile(json: DensityJson, path = '$'): number {
    if (typeof json === 'number') return this.add({ op: 'const', value: json });
    if (typeof json === 'string') return this.ref(qualify(json), path);
    if (!json || typeof json !== 'object' || typeof json.type !== 'string') {
      throw new DensityCompileError(`${path}: expected number, id or object with "type"`);
    }
    const type = json.type.replace(/^minecraft:/, '');
    const arg = (k: string): number => {
      if (!(k in json)) throw new DensityCompileError(`${path}: ${type} missing "${k}"`);
      return this.compile(json[k] as DensityJson, `${path}.${k}`);
    };
    const num = (k: string, fallback?: number): number => {
      const v = json[k] ?? fallback;
      if (typeof v !== 'number') throw new DensityCompileError(`${path}: ${type}.${k} must be a number`);
      return v;
    };
    const noiseId = (k: string): string => {
      const v = json[k];
      if (typeof v !== 'string') throw new DensityCompileError(`${path}: ${type}.${k} must be a noise id (inline noise is unsupported)`);
      const id = qualify(v);
      if (!this.bundle.noise[id]) throw new DensityCompileError(`${path}: unknown noise ${id}`);
      if (!this.noises.includes(id)) this.noises.push(id);
      return id;
    };

    if (PASSTHROUGH.has(type)) return arg('argument');
    if (UNARY.has(type)) return this.add({ op: 'unary', fn: type as UnaryOp, a: arg('argument') });
    if (BINARY.has(type)) return this.add({ op: 'binary', fn: type as BinaryOp, a: arg('argument1'), b: arg('argument2') });
    switch (type) {
      case 'constant': return this.add({ op: 'const', value: num('argument') });
      case 'blend_offset': return this.add({ op: 'const', value: 0 });
      case 'blend_alpha': return this.add({ op: 'const', value: 1 });
      case 'beardifier': return this.add({ op: 'const', value: 0 });
      case 'y_clamped_gradient':
        return this.add({ op: 'y_gradient', fromY: num('from_y'), toY: num('to_y'), fromValue: num('from_value'), toValue: num('to_value') });
      case 'clamp': return this.add({ op: 'clamp', a: arg('input'), min: num('min'), max: num('max') });
      case 'range_choice':
        return this.add({
          op: 'range_choice', input: arg('input'), min: num('min_inclusive'), max: num('max_exclusive'),
          inside: arg('when_in_range'), outside: arg('when_out_of_range'),
        });
      case 'noise': {
        const zero = this.add({ op: 'const', value: 0 });
        return this.add({ op: 'noise', noise: noiseId('noise'), xzScale: num('xz_scale', 1), yScale: num('y_scale', 1), sx: zero, sy: zero, sz: zero });
      }
      case 'shifted_noise':
        return this.add({
          op: 'noise', noise: noiseId('noise'), xzScale: num('xz_scale', 1), yScale: num('y_scale', 1),
          sx: arg('shift_x'), sy: arg('shift_y'), sz: arg('shift_z'),
        });
      case 'shift_a': return this.add({ op: 'shift', noise: noiseId('argument'), axes: 'a' });
      case 'shift_b': return this.add({ op: 'shift', noise: noiseId('argument'), axes: 'b' });
      case 'shift': return this.add({ op: 'shift', noise: noiseId('argument'), axes: 'xyz' });
      case 'spline': return this.add({ op: 'spline', spline: this.spline(json.spline, `${path}.spline`) });
      case 'end_islands': return this.add({ op: 'end_islands' });
      default:
        throw new DensityCompileError(`${path}: density function type "${json.type}" is not supported for biome sampling`);
    }
  }

  private ref(id: string, path: string): number {
    const hit = this.byRef.get(id);
    if (hit !== undefined) return hit;
    const def = this.bundle.density_function[id];
    if (def === undefined) throw new DensityCompileError(`${path}: unknown density function ${id}`);
    if (this.resolving.has(id)) throw new DensityCompileError(`${path}: cyclic reference through ${id}`);
    this.resolving.add(id);
    const n = this.compile(def, id);
    this.resolving.delete(id);
    this.byRef.set(id, n);
    return n;
  }

  private spline(json: unknown, path: string): SplineIR {
    if (typeof json === 'number') return { kind: 'const', value: Math.fround(json) };
    if (!json || typeof json !== 'object') throw new DensityCompileError(`${path}: spline must be a number or object`);
    const s = json as { coordinate?: DensityJson; points?: { location: number; value: unknown; derivative: number }[] };
    if (s.coordinate === undefined || !Array.isArray(s.points) || s.points.length === 0) {
      throw new DensityCompileError(`${path}: spline needs "coordinate" and non-empty "points"`);
    }
    const coord = this.compile(s.coordinate, `${path}.coordinate`);
    const pts = s.points;
    for (let i = 1; i < pts.length; i++) {
      if (!(pts[i]!.location >= pts[i - 1]!.location)) throw new DensityCompileError(`${path}: spline locations must be ascending`);
    }
    return {
      kind: 'multi',
      id: this.splineCount++,
      coord,
      locations: pts.map((p) => Math.fround(p.location)),
      values: pts.map((p, i) => this.spline(p.value, `${path}.points[${i}].value`)),
      derivatives: pts.map((p) => Math.fround(p.derivative)),
    };
  }

  private add(node: Node): number {
    const key = node.op === 'spline' ? `spline#${this.splineCount}#${this.nodes.length}` : JSON.stringify(node);
    const hit = this.byKey.get(key);
    if (hit !== undefined) return hit;
    this.nodes.push(node);
    const idx = this.nodes.length - 1;
    this.byKey.set(key, idx);
    return idx;
  }
}

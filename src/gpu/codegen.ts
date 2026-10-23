// Lowers a DimensionModel to one WGSL compute shader + packed data.
//
// WGSL has no f64, so precision is recovered structurally:
// - Noise coordinates are carried as Coord { i: i32, f: f32 } (integer cell +
//   fraction). Block coordinates times power-of-two scales, the 337/331
//   second-sampler stretch, and the lattice offsets are all applied with exact
//   integer arithmetic; only small fractions go through f32.
// - End-island simplex skew uses 48-bit fixed-point multiplies so the lattice
//   cell is exact at any distance.
// - Climate tree distances are exact 64-bit integers (u32 pairs), so ties
//   resolve exactly like the CPU path.
// Remaining f32 error is in octave sums and splines; tools/gpu-diff.ts measures it.

import { DIMS } from '../core/climate';
import type { Node, SplineIR } from '../core/density';
import type { NoiseSet } from '../core/evaluate';
import type { DimensionModel } from '../core/generator';
import type { Octave } from '../core/noise';

export const WORKGROUP = 64;
/** u32 words per octave: 64 packed perm words + 3 x (int, frac bits). */
const OCT_STRIDE = 70;
const TREE_STRIDE = DIMS * 2 + 2;

export interface GpuProgram {
  wgsl: string;
  /** Octave ranges per noise in the packed octave buffer (shape is seed independent). */
  octaveLayout: { noise: string; first: number; countA: number; countB: number }[];
  /** Climate tree: per node DIMS*2 bounds, child, count (i32). */
  tree: Int32Array;
  entryBiome: Int32Array;
  biomes: string[];
}

function lit(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`non-finite constant ${v}`);
  const s = Math.fround(v).toPrecision(9);
  return `f32(${s})`;
}

function exactLog2(v: number): number | null {
  if (!(v > 0)) return null;
  const e = Math.log2(v);
  return Number.isInteger(e) ? e : null;
}

/** 48-bit fixed-point limbs (16 bits each, high first) of c in [0,1). */
function fixedLimbs(c: number): [number, number, number] {
  const k = BigInt(Math.round(c * 2 ** 48));
  return [Number((k >> 32n) & 0xffffn), Number((k >> 16n) & 0xffffn), Number(k & 0xffffn)];
}

export function buildGpuProgram(model: DimensionModel, noises: NoiseSet): GpuProgram {
  const program = model.program;
  const octaveLayout: GpuProgram['octaveLayout'] = [];
  let cursor = 0;
  const noiseFns: string[] = [];
  const noiseIndex = new Map<string, number>();

  program.noises.forEach((id, k) => {
    const n = noises.byId.get(id)!;
    const a: Octave[] = n.a.octaves, b: Octave[] = n.b.octaves;
    octaveLayout.push({ noise: id, first: cursor, countA: a.length, countB: b.length });
    noiseIndex.set(id, k);
    const lines = ['  var a: f32 = 0.0;', '  var b: f32 = 0.0;'];
    const call = (o: Octave, slot: number, stretched: boolean): string => {
      const e = exactLog2(o.inputFactor);
      if (e === null) throw new Error(`noise ${id}: non power-of-two octave factor ${o.inputFactor}`);
      const ax = (c: string): string => (stretched ? `stretch_b(scale_pow2(${c}, ${e}))` : `scale_pow2(${c}, ${e})`);
      return `lattice(${slot}u, ${ax('p.x')}, ${ax('p.y')}, ${ax('p.z')})`;
    };
    a.forEach((o, i) => lines.push(`  a += ${lit(o.weight)} * ${call(o, cursor + i, false)};`));
    b.forEach((o, i) => lines.push(`  b += ${lit(o.weight)} * ${call(o, cursor + a.length + i, true)};`));
    lines.push(`  return (a + b) * ${lit(n.valueFactor)};`);
    noiseFns.push(`fn noise_${k}(p: Pt) -> f32 {\n${lines.join('\n')}\n}`);
    cursor += a.length + b.length;
  });

  const splineFns: string[] = [];
  const splineRef = (s: SplineIR): string => (s.kind === 'const' ? lit(s.value) : `spline_${s.id}(v)`);
  const emitSpline = (s: SplineIR): void => {
    if (s.kind === 'const') return;
    const n = s.locations.length;
    const L = (i: number): string => lit(s.locations[i]!);
    const D = (i: number): string => lit(s.derivatives[i]!);
    const val = (i: number): string => splineRef(s.values[i]!);
    // Mirrors the CPU float evaluation order exactly (a + t*(b-a), not mix()).
    const body = [`  let x = (*v).n[${s.coord}];`];
    body.push(`  if (x < ${L(0)}) { return ${val(0)} + ${D(0)} * (x - ${L(0)}); }`);
    for (let i = 0; i < n - 1; i++) {
      body.push(`  if (x < ${L(i + 1)}) {`);
      body.push(`    let lo = ${val(i)}; let hi = ${val(i + 1)}; let span = ${L(i + 1)} - ${L(i)};`);
      body.push(`    let t = (x - ${L(i)}) / span;`);
      body.push(`    let p = ${D(i)} * span - (hi - lo); let q = -${D(i + 1)} * span + (hi - lo);`);
      body.push('    return (lo + t * (hi - lo)) + (t * (1.0 - t)) * (p + t * (q - p));');
      body.push('  }');
    }
    body.push(`  return ${val(n - 1)} + ${D(n - 1)} * (x - ${L(n - 1)});`);
    splineFns.push(`fn spline_${s.id}(v: ptr<function, Vals>) -> f32 {\n${body.join('\n')}\n}`);
    s.values.forEach(emitSpline);
  };

  const r = (k: number): string => `vals.n[${k}]`;
  const coordExpr = (b: string, scale: number, shift: string): string => {
    if (scale === 0) return `pt_f(${shift})`;
    const e = exactLog2(scale);
    return e !== null ? `pt_pow2(${b}, ${e}, ${shift})` : `pt_f(f32(${b}) * ${lit(scale)} + ${shift})`;
  };
  const nodeExpr = (n: Node): string => {
    switch (n.op) {
      case 'const': return lit(n.value);
      case 'y_linear': return `${lit(n.offset)} + f32(by) * ${lit(n.scale)}`;
      case 'y_gradient': {
        const t = `clamp((f32(by) - ${lit(n.fromY)}) / ${lit(n.toY - n.fromY)}, 0.0, 1.0)`;
        return `${lit(n.fromValue)} + ${t} * ${lit(n.toValue - n.fromValue)}`;
      }
      case 'unary': {
        const a = r(n.a);
        switch (n.fn) {
          case 'abs': return `abs(${a})`;
          case 'square': return `${a} * ${a}`;
          case 'cube': return `${a} * ${a} * ${a}`;
          case 'half_negative': return `select(${a} * 0.5, ${a}, ${a} > 0.0)`;
          case 'quarter_negative': return `select(${a} * 0.25, ${a}, ${a} > 0.0)`;
          case 'invert': return `1.0 / ${a}`;
          case 'squeeze': return `squeeze(${a})`;
        }
        throw new Error('unreachable');
      }
      case 'binary':
        if (n.fn === 'add') return `${r(n.a)} + ${r(n.b)}`;
        if (n.fn === 'mul') return `${r(n.a)} * ${r(n.b)}`;
        return `${n.fn}(${r(n.a)}, ${r(n.b)})`;
      case 'clamp': return `clamp(${r(n.a)}, ${lit(n.min)}, ${lit(n.max)})`;
      case 'range_choice':
        return `select(${r(n.outside)}, ${r(n.inside)}, ${r(n.input)} >= ${lit(n.min)} && ${r(n.input)} < ${lit(n.max)})`;
      case 'noise':
        return `noise_${noiseIndex.get(n.noise)}(Pt(${coordExpr('bx', n.xzScale, r(n.sx))}, ${coordExpr('by', n.yScale, r(n.sy))}, ${coordExpr('bz', n.xzScale, r(n.sz))}))`;
      case 'shift': {
        const X = 'pt_pow2(bx, -2, 0.0)', Y = 'pt_pow2(by, -2, 0.0)', Z = 'pt_pow2(bz, -2, 0.0)', O = 'pt_f(0.0)';
        const pt = n.axes === 'a' ? `${X}, ${O}, ${Z}` : n.axes === 'b' ? `${Z}, ${X}, ${O}` : `${X}, ${Y}, ${Z}`;
        return `noise_${noiseIndex.get(n.noise)}(Pt(${pt})) * 4.0`;
      }
      case 'spline':
        if (n.spline.kind === 'const') return lit(n.spline.value);
        emitSpline(n.spline);
        return `spline_${n.spline.id}(&vals)`;
      case 'end_islands': return 'end_islands(bx, bz)';
    }
  };
  const evalBody = program.nodes.map((n, i) => `  vals.n[${i}] = ${nodeExpr(n)};`).join('\n');

  const idx = model.index;
  const nodesN = idx ? idx.child.length : 1;
  const tree = new Int32Array(nodesN * TREE_STRIDE);
  if (idx) {
    for (let i = 0; i < nodesN; i++) {
      const o = i * TREE_STRIDE;
      tree.set(idx.bounds.subarray(i * DIMS * 2, (i + 1) * DIMS * 2), o);
      tree[o + DIMS * 2] = idx.child[i]!;
      tree[o + DIMS * 2 + 1] = idx.count[i]!;
    }
  }

  const main = idx
    ? `  var vals = eval_all(qx * 4, qy * 4, qz * 4);
  var t: array<i32, 7>;
${model.roots.map((root, i) => `  t[${i}] = i32(vals.n[${root}] * 10000.0);`).join('\n')}
  t[6] = 0;
  if (params.mode == 1u) {
    for (var k = 0u; k < 6u; k++) { out_climate[idx * 6u + k] = t[k]; }
  }
  out_biome[idx] = u32(entry_biome[search(t)]);`
    : `  out_biome[idx] = end_biome(qx, qz);`;

  const wgsl = /* wgsl */ `// Generated by src/gpu/codegen.ts: ${model.bundle.version} / ${model.dimension.settings}
struct Params { x0: i32, z0: i32, w: u32, h: u32, step: i32, qy: i32, mode: u32, pad: u32 }
struct Vals { n: array<f32, ${program.nodes.length}> }
struct Coord { i: i32, f: f32 }
struct Pt { x: Coord, y: Coord, z: Coord }

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> octs: array<u32>;
@group(0) @binding(2) var<storage, read> tree: array<i32>;
@group(0) @binding(3) var<storage, read> entry_biome: array<i32>;
@group(0) @binding(4) var<storage, read> end_perm: array<u32>;
@group(0) @binding(5) var<storage, read_write> out_biome: array<u32>;
@group(0) @binding(6) var<storage, read_write> out_climate: array<i32>;

${sharedNoiseWgsl()}

// Returns (height, valid). The game computes cx*cx + cz*cz in wrapping int;
// when that goes negative sqrt gives NaN, which poisons the max() chain and
// makes every later comparison false. GPUs may not honour NaN, so carry it
// as a flag instead.
fn end_height(cx: i32, cz: i32) -> vec2<f32> {
  let hx = cx / 2; let hz = cz / 2;
  let ox = cx % 2; let oz = cz % 2;
  let r2 = cx * cx + cz * cz;
  if (r2 < 0) { return vec2<f32>(0.0, 0.0); }
  var best = clamp(100.0 - sqrt(f32(r2)) * 8.0, -100.0, 80.0);
  for (var i = -12; i <= 12; i++) {
    for (var j = -12; j <= 12; j++) {
      let rx = hx + i; let rz = hz + j;
      if (abs(rx) <= 64 && abs(rz) <= 64 && rx * rx + rz * rz <= 4096) { continue; }
      if (simplex2i(rx, rz) >= -0.9) { continue; }
      let size = f32(island_size(u32(abs(rx)), u32(abs(rz))) + 9u);
      let dx = f32(ox - i * 2); let dz = f32(oz - j * 2);
      best = max(best, clamp(100.0 - sqrt(dx * dx + dz * dz) * size, -100.0, 80.0));
    }
  }
  return vec2<f32>(best, 1.0);
}

fn end_islands(bx: i32, bz: i32) -> f32 { return (end_height(bx / 8, bz / 8).x - 8.0) / 128.0; }

// ------------------------------------------------------------- density graph
${splineFns.length ? '' : '// (no splines)'}
__SPLINES__

${noiseFns.join('\n\n')}

fn eval_all(bx: i32, by: i32, bz: i32) -> Vals {
  var vals: Vals;
${evalBody}
  return vals;
}

// ---------------------------------------------------------------- climate tree
// Exact squared distance as (hi, lo) u32; each axis term < 2^34.
fn box_dist(node: u32, tt: array<i32, 7>) -> vec2<u32> {
  var t = tt;
  let o = node * ${TREE_STRIDE}u;
  var hi = 0u; var lo = 0u;
  for (var d = 0u; d < 7u; d++) {
    let mn = tree[o + d * 2u]; let mx = tree[o + d * 2u + 1u];
    var e = 0u;
    if (t[d] > mx) { e = u32(t[d] - mx); } else if (t[d] < mn) { e = u32(mn - t[d]); }
    let eh = e >> 16u; let el = e & 0xffffu;
    let sl = el * el;
    let cr = 2u * eh * el;
    let l = sl + (cr << 16u);
    let h = eh * eh + (cr >> 16u) + select(0u, 1u, l < sl);
    let nl = lo + l;
    hi = hi + h + select(0u, 1u, nl < lo);
    lo = nl;
  }
  return vec2<u32>(hi, lo);
}

fn less(a: vec2<u32>, b: vec2<u32>) -> bool { return a.x < b.x || (a.x == b.x && a.y < b.y); }

fn search(t: array<i32, 7>) -> i32 {
  let root_child = tree[${DIMS * 2}];
  if (root_child < 0) { return ~root_child; }
  var stack: array<u32, 64>;
  var sp = 0u;
  let rc = u32(tree[${DIMS * 2 + 1}]);
  for (var i = 0u; i < rc; i++) { stack[sp] = u32(root_child) + rc - 1u - i; sp++; }
  var best = vec2<u32>(0xffffffffu, 0xffffffffu);
  var res = 0;
  loop {
    if (sp == 0u) { break; }
    sp--;
    let n = stack[sp];
    let d = box_dist(n, t);
    if (!less(d, best)) { continue; }
    let o = n * ${TREE_STRIDE}u;
    let c = tree[o + ${DIMS * 2}u];
    if (c < 0) { best = d; res = ~c; continue; }
    let cnt = u32(tree[o + ${DIMS * 2 + 1}u]);
    for (var i = 0u; i < cnt; i++) { stack[sp] = u32(c) + cnt - 1u - i; sp++; }
  }
  return res;
}

// Matches the order of DimensionModel.biomes for the End.
fn end_biome(qx: i32, qz: i32) -> u32 {
  let sx = (qx << 2u) >> 4u; let sz = (qz << 2u) >> 4u;
  if (abs(sx) <= 64 && abs(sz) <= 64 && sx * sx + sz * sz <= 4096) { return 0u; }
  let h = end_height(((sx * 2 + 1) * 8) / 8, ((sz * 2 + 1) * 8) / 8);
  // NaN in-game: every threshold comparison is false -> barrens.
  if (h.y == 0.0) { return 4u; }
  let e = (h.x - 8.0) / 128.0;
  if (e > 0.25) { return 1u; }
  if (e >= -0.0625) { return 2u; }
  if (e < -0.21875) { return 3u; }
  return 4u;
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.w * params.h) { return; }
  let qx = params.x0 + i32(idx % params.w) * params.step;
  let qz = params.z0 + i32(idx / params.w) * params.step;
  let qy = params.qy;
${main}
}
`.replace('__SPLINES__', splineFns.join('\n\n'));

  return { wgsl, octaveLayout, tree, entryBiome: idx ? idx.entryBiome : new Int32Array(1), biomes: model.biomes };
}

/** Packs seed-dependent octave data (perm tables + offsets) for `noises`. */
export function packOctaves(gp: GpuProgram, noises: NoiseSet): Uint32Array {
  const total = gp.octaveLayout.reduce((s, l) => s + l.countA + l.countB, 0);
  const out = new Uint32Array(Math.max(1, total) * OCT_STRIDE);
  const f = new Float32Array(1);
  const fb = new Uint32Array(f.buffer);
  const offset = (v: number, at: number): void => {
    const ip = Math.floor(v);
    out[at] = ip >>> 0;
    f[0] = v - ip;
    out[at + 1] = fb[0]!;
  };
  for (const l of gp.octaveLayout) {
    const n = noises.byId.get(l.noise)!;
    [...n.a.octaves, ...n.b.octaves].forEach((o, k) => {
      const base = (l.first + k) * OCT_STRIDE;
      const p = o.noise.perm;
      for (let i = 0; i < 64; i++) out[base + i] = (p[i * 4]! | (p[i * 4 + 1]! << 8) | (p[i * 4 + 2]! << 16) | (p[i * 4 + 3]! << 24)) >>> 0;
      offset(o.noise.xo, base + 64);
      offset(o.noise.yo, base + 66);
      offset(o.noise.zo, base + 68);
    });
  }
  return out;
}

export function packEndPerm(noises: NoiseSet): Uint32Array {
  const p = noises.endIslands.perm;
  const out = new Uint32Array(64);
  for (let i = 0; i < 64; i++) out[i] = (p[i * 4]! | (p[i * 4 + 1]! << 8) | (p[i * 4 + 2]! << 16) | (p[i * 4 + 3]! << 24)) >>> 0;
  return out;
}

/** Shared coordinate/noise WGSL for bundle-backed and standard dimensions. */
export function sharedNoiseWgsl(): string {
  const SK = fixedLimbs(0.5 * (Math.sqrt(3) - 1));
  const UN = fixedLimbs((3 - Math.sqrt(3)) / 6);
  return /* wgsl */ `
fn norm(i: i32, f: f32) -> Coord { let fl = floor(f); return Coord(i + i32(fl), f - fl); }
fn pt_f(v: f32) -> Coord { return norm(0, v); }

// b * 2^e + s, exact in the integer part.
fn pt_pow2(b: i32, e: i32, s: f32) -> Coord {
  if (e >= 0) { return norm(b << u32(e), s); }
  let sh = u32(-e);
  let ip = b >> sh;
  return norm(ip, f32(b - (ip << sh)) * exp2(f32(e)) + s);
}

fn scale_pow2(c: Coord, e: i32) -> Coord {
  if (e >= 0) { return norm(c.i << u32(e), c.f * exp2(f32(e))); }
  let sh = u32(-e);
  let ip = c.i >> sh;
  return norm(ip, (f32(c.i - (ip << sh)) + c.f) * exp2(f32(e)));
}

// c * 337/331 = c + c*6/331, integer part exact for |c.i| < 2^28.
fn stretch_b(c: Coord) -> Coord {
  let n = c.i * 6;
  var q = n / 331;
  var rem = n - q * 331;
  if (rem < 0) { rem += 331; q -= 1; }
  return norm(c.i + q, (f32(rem) + c.f * 337.0) / 331.0);
}

fn perm(o: u32, i: i32) -> i32 {
  let k = u32(i & 255);
  return i32((octs[o * ${OCT_STRIDE}u + (k >> 2u)] >> ((k & 3u) * 8u)) & 255u);
}

fn grad(h: i32, x: f32, y: f32, z: f32) -> f32 {
  switch (h & 15) {
    case 0, 12: { return x + y; }
    case 1, 14: { return -x + y; }
    case 2: { return x - y; }
    case 3: { return -x - y; }
    case 4: { return x + z; }
    case 5: { return -x + z; }
    case 6: { return x - z; }
    case 7: { return -x - z; }
    case 8: { return y + z; }
    case 9, 13: { return -y + z; }
    case 10: { return y - z; }
    default: { return -y - z; }
  }
}

fn fade(t: f32) -> f32 { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
fn lerp(t: f32, a: f32, b: f32) -> f32 { return a + t * (b - a); }

fn lattice(o: u32, cx: Coord, cy: Coord, cz: Coord) -> f32 {
  let base = o * ${OCT_STRIDE}u + 64u;
  let X = norm(cx.i + bitcast<i32>(octs[base]), cx.f + bitcast<f32>(octs[base + 1u]));
  let Y = norm(cy.i + bitcast<i32>(octs[base + 2u]), cy.f + bitcast<f32>(octs[base + 3u]));
  let Z = norm(cz.i + bitcast<i32>(octs[base + 4u]), cz.f + bitcast<f32>(octs[base + 5u]));
  let fx = X.f; let fy = Y.f; let fz = Z.f;
  let a = perm(o, X.i); let b = perm(o, X.i + 1);
  let aa = perm(o, a + Y.i); let ab = perm(o, a + Y.i + 1);
  let ba = perm(o, b + Y.i); let bb = perm(o, b + Y.i + 1);
  let n000 = grad(perm(o, aa + Z.i), fx, fy, fz);
  let n100 = grad(perm(o, ba + Z.i), fx - 1.0, fy, fz);
  let n010 = grad(perm(o, ab + Z.i), fx, fy - 1.0, fz);
  let n110 = grad(perm(o, bb + Z.i), fx - 1.0, fy - 1.0, fz);
  let n001 = grad(perm(o, aa + Z.i + 1), fx, fy, fz - 1.0);
  let n101 = grad(perm(o, ba + Z.i + 1), fx - 1.0, fy, fz - 1.0);
  let n011 = grad(perm(o, ab + Z.i + 1), fx, fy - 1.0, fz - 1.0);
  let n111 = grad(perm(o, bb + Z.i + 1), fx - 1.0, fy - 1.0, fz - 1.0);
  let sx = fade(fx); let sy = fade(fy); let sz = fade(fz);
  return lerp(sz, lerp(sy, lerp(sx, n000, n100), lerp(sx, n010, n110)),
                  lerp(sy, lerp(sx, n001, n101), lerp(sx, n011, n111)));
}

fn squeeze(a: f32) -> f32 { let c = clamp(a, -1.0, 1.0); return c / 2.0 - c * c * c / 24.0; }

// ---------------------------------------------------------------- End islands
// a * C for C in [0,1) given as 48-bit fixed point limbs; exact integer part for |a| < 2^24.
fn mulfix(a: i32, k2: u32, k1: u32, k0: u32) -> Coord {
  let u = u32(abs(a));
  let u0 = u & 0xffffu; let u1 = u >> 16u;
  var col: array<u32, 6>;
  var pp = array<u32, 6>(u0 * k0, u0 * k1, u0 * k2, u1 * k0, u1 * k1, u1 * k2);
  var at = array<u32, 6>(0u, 1u, 2u, 1u, 2u, 3u);
  for (var i = 0u; i < 6u; i++) {
    col[at[i]] += pp[i] & 0xffffu;
    col[at[i] + 1u] += pp[i] >> 16u;
  }
  for (var c = 0u; c < 5u; c++) { col[c + 1u] += col[c] >> 16u; col[c] &= 0xffffu; }
  let ip = i32(col[3] + (col[4] << 16u));
  let fr = f32(col[2]) / 65536.0 + f32(col[1]) / 4294967296.0;
  if (a >= 0) { return Coord(ip, fr); }
  if (fr == 0.0) { return Coord(-ip, 0.0); }
  return Coord(-ip - 1, 1.0 - fr);
}

fn eperm(i: i32) -> i32 { let k = u32(i & 255); return i32((end_perm[k >> 2u] >> ((k & 3u) * 8u)) & 255u); }

fn corner(g: i32, x: f32, y: f32) -> f32 {
  var c = 0.5 - x * x - y * y;
  if (c < 0.0) { return 0.0; }
  c = c * c;
  return c * c * grad(g, x, y, 0.0);
}

const UNSKEW: f32 = ${lit((3 - Math.sqrt(3)) / 6)};

fn simplex2i(rx: i32, rz: i32) -> f32 {
  let s = mulfix(rx + rz, ${SK[0]}u, ${SK[1]}u, ${SK[2]}u);
  let i = rx + s.i; let j = rz + s.i;
  let t = mulfix(i + j, ${UN[0]}u, ${UN[1]}u, ${UN[2]}u);
  let x0 = f32(rx - i + t.i) + t.f;
  let y0 = f32(rz - j + t.i) + t.f;
  var i1 = 0; var j1 = 1;
  if (x0 > y0) { i1 = 1; j1 = 0; }
  let x1 = x0 - f32(i1) + UNSKEW; let y1 = y0 - f32(j1) + UNSKEW;
  let x2 = x0 - 1.0 + 2.0 * UNSKEW; let y2 = y0 - 1.0 + 2.0 * UNSKEW;
  let g0 = eperm(i + eperm(j)) % 12;
  let g1 = eperm(i + i1 + eperm(j + j1)) % 12;
  let g2 = eperm(i + 1 + eperm(j + 1)) % 12;
  return 70.0 * (corner(g0, x0, y0) + corner(g1, x1, y1) + corner(g2, x2, y2));
}

// ---- exact u64 helpers (hi, lo) for the island size term ----
fn mul64(a: u32, b: u32) -> vec2<u32> {
  let a0 = a & 0xffffu; let a1 = a >> 16u; let b0 = b & 0xffffu; let b1 = b >> 16u;
  let p00 = a0 * b0; let p01 = a0 * b1; let p10 = a1 * b0; let p11 = a1 * b1;
  let mid = (p00 >> 16u) + (p01 & 0xffffu) + (p10 & 0xffffu);
  let lo = (p00 & 0xffffu) | (mid << 16u);
  let hi = p11 + (p01 >> 16u) + (p10 >> 16u) + (mid >> 16u);
  return vec2<u32>(hi, lo);
}
fn add64(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
  let lo = a.y + b.y;
  return vec2<u32>(a.x + b.x + select(0u, 1u, lo < a.y), lo);
}
fn shr64(v: vec2<u32>, s: u32) -> vec2<u32> {
  if (s == 0u) { return v; }
  if (s >= 32u) { return vec2<u32>(0u, v.x >> (s - 32u)); }
  return vec2<u32>(v.x >> s, (v.y >> s) | (v.x << (32u - s)));
}
fn shl64(v: vec2<u32>, s: u32) -> vec2<u32> {
  if (s == 0u) { return v; }
  if (s >= 32u) { return vec2<u32>(v.y << (s - 32u), 0u); }
  return vec2<u32>((v.x << s) | (v.y >> (32u - s)), v.y << s);
}
// Round a non-negative integer to the nearest f32 (ties to even), as an integer.
fn round_f32(v: vec2<u32>) -> vec2<u32> {
  var len = 32u - countLeadingZeros(v.y);
  if (v.x != 0u) { len = 64u - countLeadingZeros(v.x); }
  if (len <= 24u) { return v; }
  let s = len - 24u;
  var q = shr64(v, s);
  let back = shl64(q, s);
  let rlo = v.y - back.y;
  let rem = vec2<u32>(v.x - back.x - select(0u, 1u, v.y < back.y), rlo);
  let half = shl64(vec2<u32>(0u, 1u), s - 1u);
  let gt = rem.x > half.x || (rem.x == half.x && rem.y > half.y);
  let eq = rem.x == half.x && rem.y == half.y;
  if (gt || (eq && (q.y & 1u) == 1u)) { q = add64(q, vec2<u32>(0u, 1u)); }
  return shl64(q, s);
}
// (int)(float(|rx|)*3439F + float(|rz|)*147F) % 13 with the game's f32 rounding (no FMA).
fn island_size_value(ax: u32, az: u32) -> vec2<u32> {
  let fx = round_f32(vec2<u32>(0u, ax));
  let fz = round_f32(vec2<u32>(0u, az));
  let px = round_f32(add64(mul64(fx.y, 3439u), shl64(mul64(fx.x, 3439u), 32u)));
  let pz = round_f32(add64(mul64(fz.y, 147u), shl64(mul64(fz.x, 147u), 32u)));
  return round_f32(add64(px, pz));
}
fn island_size(ax: u32, az: u32) -> u32 {
  let s = island_size_value(ax, az);
  // 2^32 mod 13 == 9
  return ((s.x % 13u) * 9u + s.y % 13u) % 13u;
}
`;
}

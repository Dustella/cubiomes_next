// Multi-noise biome lookup: quantised parameter boxes + nearest-box search.
//
// The index reproduces the game's R-tree construction (fanout 6, per-level
// axis chosen by minimal summed bucket extent) because the game resolves
// equal-distance ties by tree visit order. Search semantics: depth-first in
// child order, a child is entered only if its box distance is strictly below
// the best so far, and a leaf replaces the best only if strictly closer.
// The game additionally seeds each query with the previous query's leaf on
// the same thread; `searchClimate` accepts that as an optional candidate.

import type { BiomeEntryJson, ParameterJson } from './bundle';

/** Climate.quantizeCoord: (long)(float * 10000F). */
export const quantize = (v: number): number => Math.trunc(Math.fround(Math.fround(v) * 10000));

const AXES = ['temperature', 'humidity', 'continentalness', 'erosion', 'depth', 'weirdness'] as const;
/** 6 climate axes + offset. */
export const DIMS = 7;
const FANOUT = 6;

export interface ClimateIndex {
  biomes: string[];
  /** Per entry: biome index into `biomes`. */
  entryBiome: Int32Array;
  /**
   * Flattened tree, children of a node contiguous. Node i: bounds at
   * [i*14, i*14+14) as min/max pairs. child[i] >= 0: first child node with
   * count[i] children. child[i] < 0: leaf for entry ~child[i].
   */
  bounds: Int32Array;
  child: Int32Array;
  count: Int32Array;
  /** Node index of each entry's leaf. */
  leafNode: Int32Array;
}

interface TreeNode {
  box: Int32Array;
  entry: number;
  children: TreeNode[];
}

const mid = (b: Int32Array, d: number): number => Math.trunc((b[d * 2]! + b[d * 2 + 1]!) / 2);

function unionBox(nodes: TreeNode[]): Int32Array {
  const u = new Int32Array(DIMS * 2);
  for (let d = 0; d < DIMS; d++) {
    let lo = Infinity, hi = -Infinity;
    for (const n of nodes) { lo = Math.min(lo, n.box[d * 2]!); hi = Math.max(hi, n.box[d * 2 + 1]!); }
    u[d * 2] = lo; u[d * 2 + 1] = hi;
  }
  return u;
}

const subTree = (children: TreeNode[]): TreeNode => ({ box: unionBox(children), entry: -1, children });

function sortByAxis(nodes: TreeNode[], dim: number, absolute: boolean): void {
  nodes.sort((a, b) => {
    for (let i = 0; i < DIMS; i++) {
      const d = (dim + i) % DIMS;
      let ka = mid(a.box, d), kb = mid(b.box, d);
      if (absolute) { ka = Math.abs(ka); kb = Math.abs(kb); }
      if (ka !== kb) return ka - kb;
    }
    return 0;
  });
}

function bucketize(nodes: TreeNode[]): TreeNode[] {
  const size = Math.pow(FANOUT, Math.floor(Math.log(nodes.length - 0.01) / Math.log(FANOUT)));
  const out: TreeNode[] = [];
  for (let i = 0; i < nodes.length; i += size) out.push(subTree(nodes.slice(i, i + size)));
  return out;
}

function extent(b: Int32Array): number {
  let s = 0;
  for (let d = 0; d < DIMS; d++) s += Math.abs(b[d * 2 + 1]! - b[d * 2]!);
  return s;
}

function build(nodes: TreeNode[]): TreeNode {
  if (nodes.length === 1) return nodes[0]!;
  if (nodes.length <= FANOUT) {
    const key = (n: TreeNode): number => { let s = 0; for (let d = 0; d < DIMS; d++) s += Math.abs(mid(n.box, d)); return s; };
    const sorted = [...nodes].sort((a, b) => key(a) - key(b));
    return subTree(sorted);
  }
  let bestCost = Infinity, bestDim = -1, bestBuckets: TreeNode[] = [];
  const work = [...nodes];
  for (let d = 0; d < DIMS; d++) {
    sortByAxis(work, d, false);
    const buckets = bucketize(work);
    let cost = 0;
    for (const b of buckets) cost += extent(b.box);
    if (bestCost > cost) { bestCost = cost; bestDim = d; bestBuckets = buckets; }
  }
  sortByAxis(bestBuckets, bestDim, true);
  return subTree(bestBuckets.map((b) => build(b.children)));
}

function paramRange(p: number | [number, number]): [number, number] {
  return typeof p === 'number' ? [quantize(p), quantize(p)] : [quantize(p[0]), quantize(p[1])];
}

export function buildClimateIndex(entries: BiomeEntryJson[]): ClimateIndex {
  if (entries.length === 0) throw new Error('biome parameter list is empty');
  const biomes: string[] = [];
  const biomeIdx = new Map<string, number>();
  const entryBiome = new Int32Array(entries.length);
  const leaves: TreeNode[] = entries.map((e, i) => {
    let b = biomeIdx.get(e.biome);
    if (b === undefined) { b = biomes.length; biomes.push(e.biome); biomeIdx.set(e.biome, b); }
    entryBiome[i] = b;
    const p: ParameterJson = e.parameters;
    const box = new Int32Array(DIMS * 2);
    AXES.forEach((a, d) => { const [lo, hi] = paramRange(p[a]); box[d * 2] = lo; box[d * 2 + 1] = hi; });
    const off = quantize(p.offset);
    box[12] = off; box[13] = off;
    return { box, entry: i, children: [] };
  });
  const root = build(leaves);

  // Breadth-first flatten so each node's children are contiguous.
  const order: TreeNode[] = [root];
  const first: number[] = [];
  for (let q = 0; q < order.length; q++) {
    const n = order[q]!;
    first.push(n.children.length ? order.length : -1);
    for (const c of n.children) order.push(c);
  }
  const bounds = new Int32Array(order.length * DIMS * 2);
  const child = new Int32Array(order.length);
  const count = new Int32Array(order.length);
  const leafNode = new Int32Array(entries.length);
  order.forEach((n, i) => {
    bounds.set(n.box, i * DIMS * 2);
    if (n.children.length) { child[i] = first[i]!; count[i] = n.children.length; }
    else { child[i] = ~n.entry; leafNode[n.entry] = i; }
  });
  return { biomes, entryBiome, bounds, child, count, leafNode };
}

/** Squared distance from target to node box; exact in doubles for |values| < 2^24. */
export function boxDistance(bounds: Int32Array, node: number, t: ArrayLike<number>): number {
  let s = 0;
  const o = node * DIMS * 2;
  for (let d = 0; d < DIMS; d++) {
    const v = t[d]!;
    const lo = bounds[o + d * 2]!, hi = bounds[o + d * 2 + 1]!;
    const e = v > hi ? v - hi : v < lo ? lo - v : 0;
    s += e * e;
  }
  return s;
}

/**
 * Nearest entry for a quantised 7-vector target (offset axis = 0).
 * `candidate` is an entry index to start from (the game's per-thread last result), or -1.
 */
export function searchClimate(idx: ClimateIndex, target: ArrayLike<number>, candidate = -1): number {
  const { bounds, child, count } = idx;
  let best = candidate >= 0 ? boxDistance(bounds, idx.leafNode[candidate]!, target) : Infinity;
  let res = candidate;
  if (child[0]! < 0) return ~child[0]!;
  const stack: number[] = [];
  for (let i = count[0]! - 1; i >= 0; i--) stack.push(child[0]! + i);
  while (stack.length) {
    const n = stack.pop()!;
    const d = boxDistance(bounds, n, target);
    if (!(best > d)) continue;
    const c = child[n]!;
    if (c < 0) { best = d; res = ~c; continue; }
    for (let i = count[n]! - 1; i >= 0; i--) stack.push(c + i);
  }
  return res;
}

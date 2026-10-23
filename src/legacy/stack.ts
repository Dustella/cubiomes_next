// Cubiomes generator.c setupLayerStack, MIT (Cubitect). Entry is quart scale;
// the block-scale Voronoi layer is intentionally outside this backend contract.
import { OPS } from './kernel';
import { layerSeed, type Seed } from './rng';
export interface Layer { op: number; salt: number; a: number; b: number; st: Seed; ss: Seed; }
export interface Rect { x: number; z: number; w: number; h: number; }
export interface LayerArea extends Rect { offset: number; }
export interface Plan { areas: (LayerArea | undefined)[]; size: number; }
export function makeStack(mc: number, large: boolean): Layer[] {
  if (!Number.isInteger(mc) || mc < 3 || mc > 21) throw new RangeError('Legacy Overworld requires Cubiomes release version 3 through 21');
  if (large && mc < 6) throw new RangeError('Large biomes requires release 1.3 or newer');
  const layers: Layer[] = [];
  let p = -1;
  const add = (op: number, salt: number, a = p, b = -1): number => {
    p = layers.length; layers.push({ op, salt, a, b, st: 0n, ss: 0n }); return p;
  };
  const zoom = (salt: number): number => add(OPS.Zoom, salt);
  const land = mc <= 9 ? OPS.Land16 : OPS.Land;
  add(OPS.Continent, 1); add(OPS.Fuzzy, 2000); add(land, 1);
  zoom(2001); add(land, 2);
  if (mc <= 9) {
    add(OPS.Snow16, 2); zoom(2002); add(land, 3); zoom(2003); add(land, 4); add(OPS.Mushroom, 5);
  } else {
    add(land, 50); add(land, 70); add(OPS.Island, 2); add(OPS.Snow, 2); add(land, 3);
    add(OPS.Cool, 2); add(OPS.Heat, 2); add(OPS.Special, 3); zoom(2002); zoom(2003);
    add(land, 4); add(OPS.Mushroom, 5); add(OPS.DeepOcean, 4);
  }
  const terrain = p;
  add(OPS.Biome, 200); if (mc >= 17) add(OPS.Bamboo, 1001);
  zoom(1000); zoom(1001); if (mc >= 10) add(OPS.BiomeEdge, 1000);
  const biomes64 = p;
  add(OPS.Noise, 100, terrain);
  const riverInit = p;
  if (mc > 3) { zoom(mc <= 15 ? 0 : 1000); zoom(mc <= 15 ? 0 : 1001); }
  const hillsNoise = p;
  if (mc <= 3) p = biomes64;
  else add(OPS.Hills, 1000, biomes64, hillsNoise);
  if (mc >= 10) add(OPS.Sunflower, 1001);
  zoom(1000); add(land, 3);
  if (mc <= 3) add(OPS.Shore, 1000);
  zoom(1001);
  if (mc > 3) add(OPS.Shore, 1000);
  if (mc > 3 && mc <= 9) add(OPS.SwampRiver, 1000);
  zoom(1002); zoom(1003);
  if (large) { zoom(1004); zoom(1005); }
  add(OPS.Smooth, 1000);
  const biomeFinal = p;
  p = riverInit;
  zoom(1000); zoom(1001);
  if (mc <= 9) { zoom(1002); zoom(1003); zoom(1004); zoom(1005); }
  else { zoom(1000); zoom(1001); zoom(1002); zoom(1003); }
  if (large && mc <= 10) { zoom(mc <= 9 ? 1006 : 1004); zoom(mc <= 9 ? 1007 : 1005); }
  add(OPS.River, 1); add(OPS.Smooth, 1000);
  add(OPS.RiverMix, 100, biomeFinal, p);
  if (mc >= 16) {
    const landFinal = p;
    add(OPS.OceanTemp, 2, -1);
    for (let i = 2001; i <= 2006; i++) zoom(i);
    add(OPS.OceanMix, 100, landFinal, p);
  }
  // A large-biomes graph can reach the same source layer at different scales
  // (1.8+ rivers do not receive the two extra biome zooms). Coalescing these
  // distant requests into one rectangle would allocate the space between them.
  // Expand the small DAG into a tree: each dependency gets its own bounded area.
  const tree: Layer[] = [];
  const append = (index: number): number => {
    if (index < 0) return -1;
    const l = layers[index]!;
    const a = append(l.a), b = append(l.b);
    const result = tree.length;
    tree.push({ ...l, a, b });
    return result;
  };
  append(layers.length - 1);
  return tree;
}
export function seedStack(layers: Layer[], seed: Seed): void {
  for (const l of layers) Object.assign(l, layerSeed(seed, l.salt));
}
export function parentRect(op: number, r: Rect, second = false): Rect {
  if (op === OPS.Zoom || op === OPS.Fuzzy) {
    const x = Math.floor(r.x / 2), z = Math.floor(r.z / 2);
    return { x, z, w: Math.floor((r.x + r.w - 1) / 2) - x + 2, h: Math.floor((r.z + r.h - 1) / 2) - z + 2 };
  }
  let border = 0;
  switch (op) {
    case OPS.OceanMix: border = second ? 0 : 8; break;
    case OPS.Land: case OPS.Land16: case OPS.Island: case OPS.Cool:
    case OPS.Heat: case OPS.Mushroom: case OPS.DeepOcean: case OPS.BiomeEdge:
    case OPS.Hills: case OPS.River: case OPS.Smooth: case OPS.Shore:
      border = 1; break;
  }
  return { x: r.x - border, z: r.z - border, w: r.w + border * 2, h: r.h + border * 2 };
}
export function planStack(layers: Layer[], rect: Rect): Plan {
  const areas: (LayerArea | undefined)[] = new Array(layers.length);
  const request = (i: number, r: Rect): void => {
    if (i < 0) return;
    areas[i] = { ...r, offset: 0 };
    const l = layers[i]!;
    if (l.a >= 0) request(l.a, parentRect(l.op, r));
    if (l.b >= 0) request(l.b, parentRect(l.op, r, true));
  };
  request(layers.length - 1, rect);
  let size = 0;
  for (const area of areas) if (area) { area.offset = size; size += area.w * area.h; }
  return { areas, size };
}

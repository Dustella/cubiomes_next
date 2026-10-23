// Layer cell rules ported from Cubiomes layers.c / biomes.c (MIT, Cubitect).
// No game sources are used. tools/export-legacy.ts translates this deliberately
// small, typed integer subset to WGSL; CPU and GPU therefore share the rules.
import { chunk, first, bit, step, type Seed } from './rng';
export interface CellContext {
  mc: number; st: Seed; ss: Seed;
  a(x: number, z: number): number;
  b(x: number, z: number): number;
  noise(x: number, z: number): number;
}
export const OPS = {
  Continent: 0, Fuzzy: 1, Zoom: 2, Land: 3, Land16: 4, Island: 5,
  Snow16: 6, Snow: 7, Cool: 8, Heat: 9, Special: 10, Mushroom: 11,
  DeepOcean: 12, Biome: 13, Noise: 14, Bamboo: 15, BiomeEdge: 16,
  Hills: 17, River: 18, Smooth: 19, Sunflower: 20, Shore: 21,
  SwampRiver: 22, RiverMix: 23, OceanTemp: 24, OceanMix: 25,
} as const;
export function any4(id: number, a: number, b: number, c: number, d: number): boolean {
  return id === a || id === b || id === c || id === d;
}
export function shallow(id: number): boolean { return id === 0 || id === 10 || id === 44 || id === 45 || id === 46; }
export function deep(id: number): boolean { return id === 24 || id === 47 || id === 48 || id === 49 || id === 50; }
export function ocean(id: number): boolean { return shallow(id) || deep(id); }
export function snowy(id: number): boolean {
  return id === 10 || id === 11 || id === 12 || id === 13 || id === 26 || id === 30 || id === 31 || id === 140 || id === 158;
}
export function mesa(id: number): boolean { return id === 37 || id === 38 || id === 39 || id === 165 || id === 166 || id === 167; }
export function category(mc: number, id: number): number {
  switch (id) {
    case 16: case 26: return 16;
    case 2: case 17: case 130: return 2;
    case 3: case 20: case 34: case 131: case 162: return 3;
    case 4: case 18: case 27: case 28: case 29: case 132: case 155: case 156: case 157: return 4;
    case 12: case 13: case 140: return 12;
    case 21: case 22: case 23: case 149: case 151: case 168: case 169: return 21;
    case 37: case 165: case 166: case 167: return 37;
    case 38: case 39: return mc <= 18 ? 37 : 39;
    case 14: case 15: return 14;
    case 25: return 25;
    case 0: case 10: case 24: case 44: case 45: case 46: case 47: case 48: case 49: case 50: return 0;
    case 1: case 129: return 1;
    case 7: case 11: return 7;
    case 35: case 36: case 163: case 164: return 35;
    case 6: case 134: return 6;
    case 5: case 19: case 30: case 31: case 32: case 33: case 133: case 158: case 160: case 161: return 5;
    default: return -1;
  }
}
export function similar(mc: number, a: number, b: number): boolean {
  if (a === b) return true;
  if (mc <= 18 && (a === 38 || a === 39)) return b === 38 || b === 39;
  return category(mc, a) === category(mc, b);
}
export function mutated(mc: number, id: number): number {
  switch (id) {
    case 1: return 129; case 2: return 130; case 3: return 131;
    case 4: return 132; case 5: return 133; case 6: return 134;
    case 12: return 140; case 21: return 149; case 23: return 151;
    case 27: return mc >= 12 && mc <= 13 ? 156 : 155;
    case 28: return mc >= 12 && mc <= 13 ? -1 : 156;
    case 29: return 157; case 30: return 158; case 32: return 160;
    case 33: return 161; case 34: return 162; case 35: return 163;
    case 36: return 164; case 37: return 165; case 38: return 166;
    case 39: return 167; default: return -1;
  }
}
export function biomeChoice(group: number, r: number): number {
  if (group === 1) { if (r < 3) return 2; if (r < 5) return 35; return 1; }
  if (group === 2) { switch (r) { case 0: return 4; case 1: return 29; case 2: return 3; case 3: return 1; case 4: return 27; default: return 6; } }
  if (group === 3) { switch (r) { case 0: return 4; case 1: return 3; case 2: return 5; default: return 1; } }
  if (group === 4) return r < 3 ? 12 : 30;
  switch (r) { case 0: return 2; case 1: return 4; case 2: return 3; case 3: return 6; case 4: return 1; case 5: return 5; default: return 21; }
}
export function reduce(id: number): number { return id >= 2 ? 2 + (id & 1) : id; }
export function jungleNeighbor(mc: number, id: number): boolean { return category(mc, id) === 21 || id === 4 || id === 5 || ocean(id); }
export function cell(c: CellContext, op: number, x: number, z: number): number {
  let cs: Seed = chunk(c.ss, x, z);
  if (op === 0) return (x === 0 && z === 0) || first(cs, 10) === 0 ? 1 : 0;
  if (op === 24) return c.noise(x, z);
  if (op === 1 || op === 2) {
    const px: number = x >> 1;
    const pz: number = z >> 1;
    const a: number = c.a(px, pz);
    if ((x & 1) === 0 && (z & 1) === 0) return a;
    const b: number = c.a(px, pz + 1);
    const d: number = c.a(px + 1, pz);
    const e: number = c.a(px + 1, pz + 1);
    cs = chunk(c.ss, px * 2, pz * 2);
    if ((x & 1) === 0) return bit(cs, 1) !== 0 ? b : a;
    cs = step(cs, c.st);
    if ((z & 1) === 0) return bit(cs, 1) !== 0 ? d : a;
    if (op === 2) {
      const ca: number = (a === d ? 1 : 0) + (a === b ? 1 : 0) + (a === e ? 1 : 0);
      const cd: number = (d === b ? 1 : 0) + (d === e ? 1 : 0);
      const cb: number = b === e ? 1 : 0;
      if (ca > cd && ca > cb) return a;
      if (cd > ca) return d;
      if (cb > ca) return b;
    }
    cs = step(cs, c.st);
    const r: number = bit(cs, 3);
    return r === 0 ? a : r === 1 ? d : r === 2 ? b : e;
  }
  let v: number = c.a(x, z);
  if (op === 3 || op === 4) {
    const a: number = c.a(x - 1, z - 1);
    const b: number = c.a(x + 1, z - 1);
    const d: number = c.a(x - 1, z + 1);
    const e: number = c.a(x + 1, z + 1);
    if (v === 0 && (a !== 0 || b !== 0 || d !== 0 || e !== 0)) {
      let n: number = 0;
      v = 1;
      if (a !== 0) { n++; v = a; cs = step(cs, c.st); }
      if (b !== 0) { n++; if (n === 1 || first(cs, n) === 0) v = b; cs = step(cs, c.st); }
      if (d !== 0) { n++; if (n === 1 || first(cs, n) === 0) v = d; cs = step(cs, c.st); }
      if (e !== 0) { n++; if (n === 1 || first(cs, n) === 0) v = e; cs = step(cs, c.st); }
      if ((op === 4 || v !== 4) && first(cs, 3) !== 0) v = op === 4 && v === 12 ? 10 : 0;
    } else if (v !== 0 && (a === 0 || b === 0 || d === 0 || e === 0)) {
      if ((op === 4 || v !== 4) && first(cs, 5) === 0) v = op === 4 && v === 12 ? 10 : 0;
    }
    return v;
  }
  if (op === 6) return v !== 0 ? (first(cs, 5) === 0 ? 12 : 1) : v;
  if (op === 7) { if (shallow(v)) return v; const r: number = first(cs, 6); return r === 0 ? 4 : r <= 1 ? 3 : 1; }
  if (op === 10) { if (v !== 0 && first(cs, 13) === 0) v |= ((1 + first(step(cs, c.st), 15)) << 8) & 3840; return v; }
  if (op === 11) {
    if (v === 0 && c.a(x - 1, z - 1) === 0 && c.a(x + 1, z - 1) === 0 && c.a(x - 1, z + 1) === 0 && c.a(x + 1, z + 1) === 0 && first(cs, 100) === 0) return 14;
    return v;
  }
  if (op === 13) {
    const hi: number = v & 3840;
    v &= ~3840;
    if (c.mc <= 9) {
      if (v === 0 || v === 14) return v;
      const choice: number = biomeChoice(0, first(cs, c.mc <= 4 ? 6 : 7));
      return v !== 1 && (choice !== 5 || c.mc <= 5) ? 12 : choice;
    }
    if (ocean(v) || v === 14) return v;
    if (v === 1) return hi !== 0 ? (first(cs, 3) === 0 ? 39 : 38) : biomeChoice(1, first(cs, 6));
    if (v === 2) return hi !== 0 ? 21 : biomeChoice(2, first(cs, 6));
    if (v === 3) return hi !== 0 ? 32 : biomeChoice(3, first(cs, 4));
    if (v === 4) return biomeChoice(4, first(cs, 4));
    return 14;
  }
  if (op === 14) return v > 0 ? first(cs, c.mc <= 9 ? 2 : 299999) + 2 : 0;
  if (op === 15) return v === 21 && first(cs, 10) === 0 ? 168 : v;
  if (op === 20) return v === 1 && first(cs, 57) === 0 ? 129 : v;
  if (op === 22) return (v === 6 || v === 21 || v === 22) && first(cs, v === 6 ? 6 : 8) === 0 ? 7 : v;
  if (op === 23) {
    if (c.b(x, z) === 7 && v !== 0 && (c.mc <= 9 || !ocean(v))) {
      if (v === 12) return 11;
      if (v === 14 || v === 15) return 15;
      return 7;
    }
    return v;
  }
  if (op === 25) {
    if (!ocean(v)) return v;
    let t: number = c.b(x, z);
    if (t === 44 || t === 10) {
      for (let dx: number = -8; dx <= 8; dx += 4) {
        for (let dz: number = -8; dz <= 8; dz += 4) {
          if (!ocean(c.a(x + dx, z + dz))) return t === 44 ? 45 : 46;
        }
      }
    }
    if (v === 24) {
      if (t === 45) t = 48;
      else if (t === 0) t = 24;
      else if (t === 46) t = 49;
      else if (t === 10) t = 50;
    }
    return t;
  }
  const n: number = c.a(x, z - 1);
  const e: number = c.a(x + 1, z);
  const w: number = c.a(x - 1, z);
  const s: number = c.a(x, z + 1);
  if (op === 5) return v === 0 && n === 0 && e === 0 && w === 0 && s === 0 && first(cs, 2) === 0 ? 1 : v;
  if (op === 8) return v === 1 && (any4(3, n, e, w, s) || any4(4, n, e, w, s)) ? 2 : v;
  if (op === 9) return v === 4 && (any4(1, n, e, w, s) || any4(2, n, e, w, s)) ? 3 : v;
  if (op === 12) {
    if (shallow(v) && shallow(n) && shallow(e) && shallow(w) && shallow(s)) {
      if (v === 44) return 47; if (v === 45) return 48;
      if (v === 46) return 49; if (v === 10) return 50; return 24;
    }
    return v;
  }
  if (op === 16) {
    if (v === 38 || v === 39 || v === 32) return similar(c.mc, n, v) && similar(c.mc, e, v) && similar(c.mc, w, v) && similar(c.mc, s, v) ? v : v === 32 ? 5 : 37;
    if (v === 2 && any4(12, n, e, w, s)) return 34;
    if (v === 6) {
      if (any4(2, n, e, w, s) || any4(30, n, e, w, s) || any4(12, n, e, w, s)) return 1;
      if (any4(21, n, e, w, s) || any4(168, n, e, w, s)) return 23;
    }
    return v;
  }
  if (op === 17) {
    const b: number = c.b(x, z);
    const bn: number = c.mc >= 10 ? (b - 2) % 29 : -1;
    if (bn === 1 && b >= 2 && !shallow(v)) { const m: number = mutated(c.mc, v); return m > 0 ? m : v; }
    if (bn !== 0 && first(cs, 3) !== 0) return v;
    let hill: number = v;
    switch (v) {
      case 2: hill = 17; break; case 4: hill = 18; break; case 27: hill = 28; break;
      case 29: hill = 1; break; case 5: hill = 19; break; case 32: hill = 33; break;
      case 30: hill = 31; break;
      case 1: cs = step(cs, c.st); hill = c.mc <= 9 ? 4 : first(cs, 3) === 0 ? 18 : 4; break;
      case 12: hill = 13; break; case 21: hill = 22; break; case 168: hill = 169; break;
      case 0: if (c.mc >= 10) hill = 24; break;
      case 3: if (c.mc >= 10) hill = 34; break;
      case 35: hill = 36; break;
      default:
        if (similar(c.mc, v, 38)) hill = 37;
        else if (deep(v)) {
          cs = step(cs, c.st);
          if (first(cs, 3) === 0) { cs = step(cs, c.st); hill = first(cs, 2) === 0 ? 1 : 4; }
        }
    }
    if (bn === 0 && hill !== v) { hill = mutated(c.mc, hill); if (hill < 0) hill = v; }
    let count: number = 0;
    if (similar(c.mc, n, v)) count++;
    if (similar(c.mc, e, v)) count++;
    if (similar(c.mc, w, v)) count++;
    if (similar(c.mc, s, v)) count++;
    return count >= (c.mc <= 9 ? 4 : 3) ? hill : v;
  }
  if (op === 18) {
    if (c.mc >= 10) return reduce(v) === reduce(n) && reduce(v) === reduce(e) && reduce(v) === reduce(w) && reduce(v) === reduce(s) ? -1 : 7;
    return v !== 0 && v === n && v === e && v === w && v === s ? -1 : 7;
  }
  if (op === 19) {
    if (v !== w || v !== n) {
      if (w === e && n === s) return bit(cs, 1) !== 0 ? n : w;
      if (w === e) v = w;
      if (n === s) v = n;
    }
    return v;
  }
  if (op === 21) {
    if (v === 14) return any4(0, n, e, w, s) ? 15 : v;
    if (c.mc <= 3) return v;
    if (c.mc <= 9) {
      if (v === 3) return n !== 3 || e !== 3 || w !== 3 || s !== 3 ? 20 : v;
      if (v !== 0 && v !== 7 && v !== 6 && any4(0, n, e, w, s)) return 16;
      return v;
    }
    const coast: boolean = ocean(n) || ocean(e) || ocean(w) || ocean(s);
    if (category(c.mc, v) === 21) {
      if (!jungleNeighbor(c.mc, n) || !jungleNeighbor(c.mc, e) || !jungleNeighbor(c.mc, w) || !jungleNeighbor(c.mc, s)) return 23;
      return coast ? 16 : v;
    }
    if (v === 3 || v === 34) return !ocean(v) && coast ? 25 : v;
    if (snowy(v)) return !ocean(v) && coast ? 26 : v;
    if (v === 37 || v === 38) return !coast && !(mesa(n) && mesa(e) && mesa(w) && mesa(s)) ? 2 : v;
    if (v !== 0 && v !== 24 && v !== 7 && v !== 6 && coast) return 16;
    return v;
  }
  return v;
}

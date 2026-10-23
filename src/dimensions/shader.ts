// Cubiomes biomenoise.c/noise.c algorithms (MIT, Copyright (c) 2020 Cubitect),
// translated to WGSL. Split-float arithmetic retains double noise precision;
// only Nether climate samples/distances and End island sizes round to f32.
import { sharedNoiseWgsl } from '../gpu/codegen';
import type { StandardDimension } from './cpu';

function ddConstant(value: number): string {
  const hi = Math.fround(value), lo = Math.fround(value - hi);
  return `vec2<f32>(${hi.toPrecision(9)}, ${lo.toPrecision(9)})`;
}

export function standardDimensionShader(version: number, dimension: StandardDimension): string {
  const constant = dimension === 'nether' ? version < 19 : version < 12;
  const body = constant ? `return ${dimension === 'nether' ? 8 : 9}u;`
    : dimension === 'nether' ? 'return nether_biome(qx, qz);' : 'return end_biome(qx, qz);';
  return /* wgsl */ `
struct Params { x0: i32, z0: i32, w: u32, h: u32, step: i32, qy: i32, pad0: u32, pad1: u32 }
struct Coord { i: i32, f: f32 }
struct Pt { x: Coord, y: Coord, z: Coord }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> octs: array<u32>;
@group(0) @binding(2) var<storage, read> end_perm: array<u32>;
@group(0) @binding(3) var<storage, read> offsets: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> output: array<u32>;
${sharedNoiseWgsl()}

// Normalized hi/lo pairs. fma recovers the product residual without a
// magnitude-dependent splitter. Integer cells never pass through a lone f32.
fn dd(x: f32) -> vec2<f32> { return vec2<f32>(x, 0.0); }
fn dn(a: f32, b: f32) -> vec2<f32> {
  let s = a + b;
  let v = s - a;
  return vec2<f32>(s, (a - (s - v)) + (b - v));
}
fn da(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let s = dn(a.x, b.x);
  return dn(s.x, s.y + (a.y + b.y));
}
fn ds(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> { return da(a, -b); }
fn dm(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let p = a.x * b.x;
  let e = fma(a.x, b.x, -p);
  return dn(p, (e + a.x * b.y) + a.y * b.x);
}
fn di(x: i32) -> vec2<f32> {
  return da(dd(f32(x >> 16u) * 65536.0), dd(f32(x & 65535)));
}
fn dfloor(v: vec2<f32>) -> i32 {
  let i = i32(floor(v.x));
  return i + i32(floor((v.x - f32(i)) + v.y));
}
fn dlt(a: vec2<f32>, b: vec2<f32>) -> bool {
  return a.x < b.x || (a.x == b.x && a.y < b.y);
}
fn dgrad(h: i32, x: vec2<f32>, y: vec2<f32>, z: vec2<f32>) -> vec2<f32> {
  switch (h & 15) {
    case 0, 12: { return da(x, y); }
    case 1, 14: { return ds(y, x); }
    case 2: { return ds(x, y); }
    case 3: { return -da(x, y); }
    case 4: { return da(x, z); }
    case 5: { return ds(z, x); }
    case 6: { return ds(x, z); }
    case 7: { return -da(x, z); }
    case 8: { return da(y, z); }
    case 9, 13: { return ds(z, y); }
    case 10: { return ds(y, z); }
    default: { return -da(y, z); }
  }
}
fn dfade(t: vec2<f32>) -> vec2<f32> {
  return dm(dm(dm(t, t), t), da(dm(t, ds(dm(t, dd(6.0)), dd(15.0))), dd(10.0)));
}
fn dl(t: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> vec2<f32> { return da(a, dm(t, ds(b, a))); }
fn dnoise(o: u32, px: vec2<f32>, pz: vec2<f32>) -> vec2<f32> {
  let x = da(px, offsets[o * 3u]);
  let y = offsets[o * 3u + 1u];
  let z = da(pz, offsets[o * 3u + 2u]);
  let ix = dfloor(x); let iy = dfloor(y); let iz = dfloor(z);
  let fx = ds(x, di(ix)); let fy = ds(y, di(iy)); let fz = ds(z, di(iz));
  let dx = ds(fx, dd(1.0)); let dy = ds(fy, dd(1.0)); let dz = ds(fz, dd(1.0));
  let a = perm(o, ix); let b = perm(o, ix + 1);
  let aa = perm(o, a + iy); let ab = perm(o, a + iy + 1);
  let ba = perm(o, b + iy); let bb = perm(o, b + iy + 1);
  let sx = dfade(fx); let sy = dfade(fy); let sz = dfade(fz);
  let n0 = dl(sx, dgrad(perm(o, aa + iz), fx, fy, fz), dgrad(perm(o, ba + iz), dx, fy, fz));
  let n1 = dl(sx, dgrad(perm(o, ab + iz), fx, dy, fz), dgrad(perm(o, bb + iz), dx, dy, fz));
  let n2 = dl(sx, dgrad(perm(o, aa + iz + 1), fx, fy, dz), dgrad(perm(o, ba + iz + 1), dx, fy, dz));
  let n3 = dl(sx, dgrad(perm(o, ab + iz + 1), fx, dy, dz), dgrad(perm(o, bb + iz + 1), dx, dy, dz));
  return dl(sz, dl(sy, n0, n1), dl(sy, n2, n3));
}
fn climate(base: u32, qx: i32, qz: i32) -> f32 {
  let x = di(qx); let z = di(qz);
  let bx = dm(x, ${ddConstant(337 / 331)}); let bz = dm(z, ${ddConstant(337 / 331)});
  var a = dd(0.0); var b = dd(0.0);
  for (var i = 0u; i < 2u; i++) {
    let scale = dd(exp2(-6.0 - f32(i)));
    let weight = select(${ddConstant(1 / 3)}, ${ddConstant(2 / 3)}, i == 1u);
    a = da(a, dm(weight, dnoise(base + i, dm(x, scale), dm(z, scale))));
    b = da(b, dm(weight, dnoise(base + 2u + i, dm(bx, scale), dm(bz, scale))));
  }
  return dm(da(a, b), ${ddConstant((10 / 6) * 2 / 3)}).x;
}
fn nether_biome(qx: i32, qz: i32) -> u32 {
  let t = climate(0u, qx, qz); let h = climate(4u, qx, qz);
  let points = array<vec3<f32>, 5>(vec3<f32>(0.0), vec3<f32>(0.0, -0.5, 0.0),
    vec3<f32>(0.4, 0.0, 0.0), vec3<f32>(0.0, 0.5, 0.140625), vec3<f32>(-0.5, 0.0, 0.030625));
  let ids = array<u32, 5>(8u, 170u, 171u, 172u, 173u);
  var best = 3.402823466e+38; var result = 8u;
  for (var i = 0u; i < 5u; i++) {
    let dx = ds(dd(points[i].x), dd(t)).x;
    let dz = ds(dd(points[i].y), dd(h)).x;
    let xx = dm(dd(dx), dd(dx)).x; let zz = dm(dd(dz), dd(dz)).x;
    let sum = da(dd(xx), dd(zz)).x;
    let distance = da(dd(sum), dd(points[i].z)).x;
    if (distance < best) { best = distance; result = ids[i]; }
  }
  return result;
}
fn dcorner(g: i32, x: vec2<f32>, z: vec2<f32>) -> vec2<f32> {
  var c = ds(ds(dd(0.5), dm(x, x)), dm(z, z));
  if (dlt(c, dd(0.0))) { return dd(0.0); }
  c = dm(c, c);
  return dm(dm(c, c), dgrad(g, x, z, dd(0.0)));
}
fn dsimplex(rx: i32, rz: i32) -> vec2<f32> {
  let s = dm(di(rx + rz), ${ddConstant(0.5 * (Math.sqrt(3) - 1))});
  let i = rx + dfloor(s); let j = rz + dfloor(s);
  let un = ${ddConstant((3 - Math.sqrt(3)) / 6)};
  let t = dm(di(i + j), un);
  let x0 = da(di(rx - i), t); let z0 = da(di(rz - j), t);
  let ix = select(0, 1, dlt(z0, x0)); let iz = 1 - ix;
  let x1 = da(ds(x0, di(ix)), un); let z1 = da(ds(z0, di(iz)), un);
  let x2 = da(ds(x0, dd(1.0)), dm(un, dd(2.0)));
  let z2 = da(ds(z0, dd(1.0)), dm(un, dd(2.0)));
  let a = dcorner(eperm(i + eperm(j)) % 12, x0, z0);
  let b = dcorner(eperm(i + ix + eperm(j + iz)) % 12, x1, z1);
  let c = dcorner(eperm(i + 1 + eperm(j + 1)) % 12, x2, z2);
  return dm(dd(70.0), da(da(a, b), c));
}
fn end_biome(qx: i32, qz: i32) -> u32 {
  let cx = qx >> 2u; let cz = qz >> 2u;
  if (abs(cx) <= 64 && abs(cz) <= 64 && cx * cx + cz * cz <= 4096) { return 9u; }
  let hx = cx * 2 + 1; let hz = cz * 2 + 1;
  ${version > 16 ? 'if (hx * hx + hz * hz < 0) { return 43u; }' : ''}
  let centerx = hx / 2; let centerz = hz / 2;
  let ox = hx % 2; let oz = hz % 2;
  var height = 14401u;
  for (var j = -12; j <= 12; j++) {
    let rz = centerz + j; let dz = oz - 2 * j;
    for (var i = -12; i <= 12; i++) {
      let rx = centerx + i;
      if (abs(rx) <= 64 && abs(rz) <= 64 && rx * rx + rz * rz <= 4096) { continue; }
      if (!dlt(dsimplex(rx, rz), dd(-0.9))) { continue; }
      // C's unsigned-int cast truncates the rounded integer to its low word.
      let size = island_size_value(u32(abs(rx)), u32(abs(rz))).y % 13u + 9u;
      let dx = ox - 2 * i;
      height = min(height, u32(dx * dx + dz * dz) * size * size);
    }
  }
  if (height < 3600u) { return 42u; }
  if (height <= 10000u) { return 41u; }
  if (height <= 14400u) { return 43u; }
  return 40u;
}
fn sample_biome(qx: i32, qz: i32) -> u32 { ${body} }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = gid.x;
  if (index >= params.w * params.h) { return; }
  let qx = params.x0 + i32(index % params.w) * params.step;
  let qz = params.z0 + i32(index / params.w) * params.step;
  output[index] = sample_biome(qx, qz);
}
`;
}

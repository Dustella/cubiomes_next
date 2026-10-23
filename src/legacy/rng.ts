// Cubiomes rng.h layer LCG, ported under its MIT license (Copyright (c) 2020 Cubitect).
// Keep all seed arithmetic modulo 2^64, including sign-extended coordinates.
export type Seed = bigint;
export function step(seed: Seed, salt: Seed): Seed {
  return BigInt.asUintN(64, seed * (seed * 6364136223846793005n + 1442695040888963407n) + salt);
}
export function chunk(seed: Seed, x: number, z: number): Seed {
  let s = BigInt.asUintN(64, seed + BigInt(x));
  s = step(s, BigInt(z)); s = step(s, BigInt(x));
  return step(s, BigInt(z));
}
export function first(seed: Seed, modulus: number): number {
  const r = Number((BigInt.asIntN(64, seed) >> 24n) % BigInt(modulus));
  return r < 0 ? r + modulus : r;
}
export function bit(seed: Seed, mask: number): number { return Number(seed >> 24n) & mask; }
export function layerSeed(world: Seed, salt: number): { st: Seed; ss: Seed } {
  if (salt === 0) return { st: 0n, ss: 0n };
  const s = BigInt(salt);
  const ls = step(step(step(s, s), s), s);
  const st = step(step(step(world, ls), ls), ls);
  return { st, ss: step(st, 0n) };
}

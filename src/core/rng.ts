// Random sources used by Minecraft 1.18+ world generation.
// BigInt is used because these only run during seeding, never per sample.

import { md5Seed } from './md5';

const M64 = (1n << 64n) - 1n;
const M48 = (1n << 48n) - 1n;

const rotl64 = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & M64;
const toI64 = (x: bigint): bigint => BigInt.asIntN(64, x);
const toU64 = (x: bigint): bigint => BigInt.asUintN(64, x);

export interface RandomSource {
  nextLong(): bigint;
  nextInt(bound: number): number;
  nextDouble(): number;
  consume(count: number): void;
  forkPositional(): PositionalRandomFactory;
}

export interface PositionalRandomFactory {
  fromHashOf(name: string): RandomSource;
}

function mixStafford13(z: bigint): bigint {
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
  return z ^ (z >> 31n);
}

/** Xoroshiro128++ as used by non-legacy world generation. */
export class Xoroshiro implements RandomSource {
  lo: bigint;
  hi: bigint;

  constructor(lo: bigint, hi: bigint) {
    lo = toU64(lo);
    hi = toU64(hi);
    if (lo === 0n && hi === 0n) {
      lo = 0x9e3779b97f4a7c15n;
      hi = 0x6a09e667f3bcc909n;
    }
    this.lo = lo;
    this.hi = hi;
  }

  static fromSeed(seed: bigint): Xoroshiro {
    const l = toU64(seed) ^ 0x6a09e667f3bcc909n;
    const h = (l + 0x9e3779b97f4a7c15n) & M64;
    return new Xoroshiro(mixStafford13(l), mixStafford13(h));
  }

  nextLong(): bigint {
    const l = this.lo;
    let h = this.hi;
    const n = (rotl64((l + h) & M64, 17n) + l) & M64;
    h ^= l;
    this.lo = rotl64(l, 49n) ^ h ^ ((h << 21n) & M64);
    this.hi = rotl64(h, 28n);
    return n;
  }

  nextInt(bound: number): number {
    const b = BigInt(bound);
    let m = (this.nextLong() & 0xffffffffn) * b;
    let low = m & 0xffffffffn;
    if (low < b) {
      const threshold = ((~b + 1n) & 0xffffffffn) % b;
      while (low < threshold) {
        m = (this.nextLong() & 0xffffffffn) * b;
        low = m & 0xffffffffn;
      }
    }
    return Number(m >> 32n);
  }

  nextDouble(): number {
    return Number(this.nextLong() >> 11n) * 2 ** -53;
  }

  consume(count: number): void {
    for (let i = 0; i < count; i++) this.nextLong();
  }

  forkPositional(): PositionalRandomFactory {
    const lo = this.nextLong();
    const hi = this.nextLong();
    return {
      fromHashOf: (name) => {
        const h = md5Seed(name);
        return new Xoroshiro(lo ^ h.lo, hi ^ h.hi);
      },
    };
  }
}

/** java.util.Random-compatible 48-bit LCG used by legacy random sources. */
export class LegacyRandom implements RandomSource {
  seed: bigint;

  constructor(seed: bigint) {
    this.seed = (toU64(seed) ^ 0x5deece66dn) & M48;
  }

  next(bits: number): number {
    this.seed = (this.seed * 0x5deece66dn + 0xbn) & M48;
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
  }

  nextLong(): bigint {
    return toU64((BigInt(this.next(32)) << 32n) + BigInt(this.next(32)));
  }

  nextInt(bound: number): number {
    if ((bound & -bound) === bound) {
      return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
    }
    let bits: number;
    let val: number;
    do {
      bits = this.next(31);
      val = bits % bound;
    } while (((bits - val + (bound - 1)) | 0) < 0);
    return val;
  }

  nextDouble(): number {
    return (this.next(26) * 2 ** 27 + this.next(27)) * 2 ** -53;
  }

  consume(count: number): void {
    for (let i = 0; i < count; i++) this.next(32);
  }

  forkPositional(): PositionalRandomFactory {
    const base = toI64(this.nextLong());
    return {
      fromHashOf: (name) => new LegacyRandom(BigInt(javaStringHash(name)) ^ base),
    };
  }
}

/** String.hashCode() over UTF-16 code units. */
export function javaStringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

/** Parses a seed the way the game's world creation screen does. */
export function parseSeed(text: string): bigint {
  const t = text.trim();
  if (/^[+-]?\d+$/.test(t)) {
    const v = BigInt(t);
    if (v >= -(1n << 63n) && v < 1n << 63n) return v;
  }
  return BigInt(javaStringHash(t));
}

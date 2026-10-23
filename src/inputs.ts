import type { Region } from './gpu/runner';

// Quart positions must remain representable after conversion to block i32.
const MIN_QUART = -536870912;
const MAX_QUART = 536870911;

export function validateSeed(seed: bigint): void {
  if (typeof seed !== 'bigint' || seed < -(1n << 63n) || seed >= (1n << 63n)) {
    throw new RangeError('seed must be a signed 64-bit bigint');
  }
}

export function validatePosition(x: number, y: number, z: number): void {
  if (!Number.isInteger(x) || x < MIN_QUART || x > MAX_QUART ||
      !Number.isInteger(y) || y < MIN_QUART || y > MAX_QUART ||
      !Number.isInteger(z) || z < MIN_QUART || z > MAX_QUART) {
    throw new RangeError('quart coordinates must be integers representable as signed 32-bit block coordinates');
  }
}

export function validateRegion(r: Region): void {
  if (!Number.isSafeInteger(r.w) || !Number.isSafeInteger(r.h) || r.w < 1 || r.h < 1 ||
      !Number.isSafeInteger(r.step) || r.step < 1 || r.step > 2147483647 ||
      !Number.isSafeInteger(r.w * r.h) || r.w * r.h > 0x3fffffff) {
    throw new RangeError('region requires positive integer w, h and step, with at most 2^30-1 samples');
  }
  validatePosition(r.x0, r.qy, r.z0);
  validatePosition(r.x0 + (r.w - 1) * r.step, r.qy, r.z0 + (r.h - 1) * r.step);
}

import { LegacyRandom } from '../core/rng';
import type { BundlePlacementBase } from './bundle-schema';

/** Coordinate arithmetic is reduced by LegacyRandom to the Java RNG's low 48 bits. */
export function saltedRandom(seed: bigint, x: number, z: number, salt: number): LegacyRandom {
  return new LegacyRandom(seed + BigInt(x) * 341873128712n + BigInt(z) * 132897987541n + BigInt(salt));
}
export function featureRandom(seed: bigint, x: number, z: number): LegacyRandom {
  const random = new LegacyRandom(seed);
  const a = random.nextLong(), b = random.nextLong();
  return new LegacyRandom((BigInt(x) * a) ^ (BigInt(z) * b) ^ seed);
}
export function frequencyPass(seed: bigint, x: number, z: number, placement: BundlePlacementBase): boolean {
  const f = Math.fround(placement.frequency);
  // The registry codec stores a Java float; its widened value is also used by
  // the double-based reducer. The reciprocal in legacy_type_1 is float again.
  if (f >= 1) return true;
  switch (placement.frequencyReductionMethod) {
    case 'legacy_type_1': {
      const random = new LegacyRandom(BigInt((x >> 4) ^ ((z >> 4) << 4)) ^ seed);
      random.next(32);
      return random.nextInt(Math.min(0x7fffffff, Math.trunc(Math.fround(1 / f)))) === 0;
    }
    case 'legacy_type_2': return saltedRandom(seed, x, z, 10387320).next(24) / 2 ** 24 < f;
    case 'legacy_type_3': return featureRandom(seed, x, z).nextDouble() < f;
    // This reducer's coordinate argument order differs from placement seeding.
    case 'default': return saltedRandom(seed, placement.salt, x, z).next(24) / 2 ** 24 < f;
  }
}
export function weightedOrder(seed: bigint, x: number, z: number, entries: readonly { structure: string; weight: number }[]): string[] {
  if (entries.length === 1) return [entries[0]!.structure];
  const random = featureRandom(seed, x, z);
  const remaining = entries.slice();
  const result: string[] = [];
  let total = remaining.reduce((sum, entry) => sum + entry.weight, 0);
  while (remaining.length) {
    let weight = random.nextInt(total);
    let index = 0;
    while ((weight -= remaining[index]!.weight) >= 0) index++;
    const entry = remaining[index]!;
    result.push(entry.structure);
    total -= entry.weight;
    remaining.splice(index, 1);
  }
  return result;
}

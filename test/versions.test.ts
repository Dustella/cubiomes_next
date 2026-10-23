// Expected IDs sampled via unmodified Cubiomes getBiomeAt(scale=4),
// tools/version-oracle.c. These points distinguish algorithm/version branches.
import { describe, expect, test } from 'bun:test';
import { CpuBiomeGenerator, resolveVersion, type Dimension } from '../src';

type Boundary = {
  before: string; after: string; dimension: Dimension; seed: bigint;
  x: number; y: number; z: number; ids: [number, number];
};
const boundaries: Boundary[] = [
  { before: '1.0', after: '1.1', dimension: 'overworld', seed: -1n, x: 291, y: -12, z: -4097, ids: [3, 20] },
  { before: '1.1', after: '1.2', dimension: 'overworld', seed: 0n, x: 28, y: 16, z: -19, ids: [0, 7] },
  { before: '1.6', after: '1.7', dimension: 'overworld', seed: 0n, x: -17, y: 16, z: -19, ids: [0, 1] },
  { before: '1.12', after: '1.13', dimension: 'overworld', seed: 9223372036854775807n, x: -6999690, y: -60, z: 6999000, ids: [24, 49] },
  { before: '1.17', after: '1.18', dimension: 'overworld', seed: 0n, x: -17, y: 16, z: -19, ids: [1, 4] },
  { before: '1.18', after: '1.19.2', dimension: 'overworld', seed: -1n, x: 495, y: -12, z: -4080, ids: [4, 183] },
  { before: '1.19', after: '1.20', dimension: 'overworld', seed: -1n, x: 257, y: -12, z: -3961, ids: [177, 185] },
  { before: '1.8', after: '1.9', dimension: 'end', seed: -1n, x: 257, y: -12, z: -4097, ids: [9, 43] },
  { before: '1.13', after: '1.14', dimension: 'end', seed: 9223372036854775807n, x: -7000000, y: -60, z: 6999000, ids: [41, 43] },
  { before: '1.15', after: '1.16.1', dimension: 'nether', seed: 0n, x: 13, y: 16, z: 2, ids: [8, 171] },
];

describe('Cubiomes release boundaries', () => {
  for (const c of boundaries) {
    test(`${c.dimension} ${c.before} -> ${c.after}`, () => {
      const a = new CpuBiomeGenerator({ version: c.before, dimension: c.dimension, seed: c.seed });
      const b = new CpuBiomeGenerator({ version: c.after, dimension: c.dimension, seed: c.seed });
      expect([a.biome(c.x, c.y, c.z), b.biome(c.x, c.y, c.z)]).toEqual(c.ids);
    });
  }

  test('Large Biomes changes both layered and noise-based worlds', () => {
    for (const [version, normal, large] of [['1.3', 1, 0], ['1.17', 17, 12], ['1.18', 155, 1]] as const) {
      const options = { version, dimension: 'overworld' as const, seed: -1n };
      expect(new CpuBiomeGenerator(options).biome(257, -12, -4097)).toBe(normal);
      expect(new CpuBiomeGenerator({ ...options, largeBiomes: true }).biome(257, -12, -4097)).toBe(large);
    }
  });

  test('differently scaled large-biome river branches stay bounded at far coordinates', () => {
    const g = new CpuBiomeGenerator({ version: '1.8', dimension: 'overworld', seed: 9223372036854775807n, largeBiomes: true });
    expect([...g.run({ x0: -7000000, z0: 6999000, w: 2, h: 2, step: 217, qy: -60 })]).toEqual([0, 0, 24, 24]);
  });

  test('major aliases cannot cross the requested version cutoff', () => {
    expect(resolveVersion('1.21').id).toBe('1.21.3');
    expect(() => resolveVersion('1.21.4')).toThrow(RangeError);
    expect(() => resolveVersion('26.2')).toThrow(RangeError);
  });

  test('rejects unsupported presets and lossy seed/coordinate inputs', () => {
    expect(() => new CpuBiomeGenerator({ version: '1.2', dimension: 'overworld', seed: 0n, largeBiomes: true })).toThrow(RangeError);
    expect(() => new CpuBiomeGenerator({ version: '1.20', dimension: 'nether', seed: 0n, largeBiomes: true })).toThrow(RangeError);
    expect(() => new CpuBiomeGenerator({ version: '1.20', dimension: 'overworld', seed: 1n << 63n })).toThrow(RangeError);
    const g = new CpuBiomeGenerator({ version: '1.20', dimension: 'overworld', seed: 0n });
    expect(() => g.biome(0.5, 0, 0)).toThrow(RangeError);
    expect(() => g.run({ x0: 0, z0: 0, w: 1, h: 1, step: 0, qy: 0 })).toThrow(RangeError);
    expect(() => g.run({ x0: 536870911, z0: 0, w: 2, h: 1, step: 1, qy: 0 })).toThrow(RangeError);
  });
});

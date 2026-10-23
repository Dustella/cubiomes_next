// Contract tests that need no Mojang data. End-to-end correctness against the
// game is covered by tools/gt-diff.ts (needs a local server jar).

import { describe, expect, test } from 'bun:test';
import type { BiomeEntryJson, WorldgenBundle } from '../src/core/bundle';
import { boxDistance, buildClimateIndex, quantize, searchClimate } from '../src/core/climate';
import { DensityCompileError, DensityProgram } from '../src/core/density';
import { md5 } from '../src/core/md5';
import { javaStringHash, LegacyRandom, parseSeed, Xoroshiro } from '../src/core/rng';

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('md5', () => {
  test('RFC 1321 vectors', () => {
    expect(hex(md5(new TextEncoder().encode('')))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(hex(md5(new TextEncoder().encode('message digest')))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    // Spans a padding block boundary.
    expect(hex(md5(new TextEncoder().encode('a'.repeat(56))))).toBe('3b0c8ac703f828b04c6c197006d17218');
  });
});

describe('seeds', () => {
  test('numeric and text seeds parse like the game', () => {
    expect(parseSeed('12345')).toBe(12345n);
    expect(parseSeed('-4172144997902289642')).toBe(-4172144997902289642n);
    expect(parseSeed('hello')).toBe(BigInt(javaStringHash('hello')));
    expect(javaStringHash('hello')).toBe(99162322);
    // Out of long range falls back to string hashing.
    expect(parseSeed('9223372036854775808')).toBe(BigInt(javaStringHash('9223372036854775808')));
  });

  test('java.util.Random compatibility', () => {
    // new Random(0).nextInt(), nextLong()
    const r = new LegacyRandom(0n);
    expect(r.next(32)).toBe(-1155484576);
    expect(BigInt.asIntN(64, new LegacyRandom(0n).nextLong())).toBe(-4962768465676381896n);
  });

  test('xoroshiro all-zero state is replaced', () => {
    const x = new Xoroshiro(0n, 0n);
    expect(x.lo).not.toBe(0n);
  });
});

const box = (lo: number, hi: number): [number, number] => [lo, hi];
function entry(biome: string, t: [number, number], offset = 0): BiomeEntryJson {
  return {
    biome,
    parameters: { temperature: t, humidity: box(-1, 1), continentalness: box(-1, 1), erosion: box(-1, 1), depth: 0, weirdness: box(-1, 1), offset },
  };
}

describe('climate index', () => {
  test('quantize truncates float*10000 like the game', () => {
    expect(quantize(0.55)).toBe(5500);
    expect(quantize(-0.7799)).toBe(-7799);
    expect(quantize(1.1)).toBe(11000);
  });

  test('nearest box wins; equal distance resolves to the first visited', () => {
    const idx = buildClimateIndex([entry('a', box(-1, -0.5)), entry('b', box(0.5, 1))]);
    const at = (t: number): string => idx.biomes[idx.entryBiome[searchClimate(idx, [quantize(t), 0, 0, 0, 0, 0, 0])]!]!;
    expect(at(-0.8)).toBe('a');
    expect(at(0.9)).toBe('b');
    // Exact tie at t = 0: deterministic and stable across calls.
    expect(at(0)).toBe(at(0));
  });

  test('tree search equals brute-force minimum distance on many entries', () => {
    const entries: BiomeEntryJson[] = [];
    for (let i = 0; i < 200; i++) {
      const lo = Math.fround(-1 + (i * 37 % 200) / 100);
      entries.push(entry(`b${i % 17}`, box(lo, Math.min(1, lo + 0.05)), (i % 3) * 0.1));
    }
    const idx = buildClimateIndex(entries);
    for (let k = 0; k < 500; k++) {
      const t = [Math.round(Math.sin(k) * 12000), 0, 0, 0, Math.round(Math.cos(k * 3) * 5000), 0, 0];
      const got = searchClimate(idx, t);
      let best = Infinity;
      for (let e = 0; e < entries.length; e++) best = Math.min(best, boxDistance(idx.bounds, idx.leafNode[e]!, t));
      expect(boxDistance(idx.bounds, idx.leafNode[got]!, t)).toBe(best);
    }
  });

  test('a strictly-closer candidate is never overridden by a tie', () => {
    const idx = buildClimateIndex([entry('a', box(-1, 0)), entry('b', box(0, 1))]);
    const t = [0, 0, 0, 0, 0, 0, 0];
    // Both contain t (distance 0); the candidate is kept because nothing is strictly closer.
    expect(searchClimate(idx, t, 1)).toBe(1);
    expect(searchClimate(idx, t, 0)).toBe(0);
  });
});

function miniBundle(df: WorldgenBundle['density_function']): WorldgenBundle {
  return {
    format: 1, version: 'test', noise: { 'minecraft:n': { firstOctave: -2, amplitudes: [1, 1] } },
    density_function: df, noise_settings: {}, biome_parameters: {}, dimensions: {},
  };
}

describe('density compiler', () => {
  test('deduplicates shared subgraphs and resolves references once', () => {
    const p = new DensityProgram(miniBundle({ 'minecraft:x': { type: 'minecraft:noise', noise: 'minecraft:n', xz_scale: 1, y_scale: 0 } }));
    const a = p.compile({ type: 'minecraft:add', argument1: 'minecraft:x', argument2: 'x' });
    const b = p.compile({ type: 'minecraft:mul', argument1: 'minecraft:x', argument2: 2 });
    expect(a).not.toBe(b);
    expect(p.nodes.filter((n) => n.op === 'noise')).toHaveLength(1);
    expect(p.noises).toEqual(['minecraft:n']);
  });

  test('reports the path of unsupported nodes and cycles', () => {
    const p = new DensityProgram(miniBundle({ 'minecraft:loop': 'minecraft:loop' }));
    expect(() => p.compile({ type: 'minecraft:add', argument1: 1, argument2: { type: 'minecraft:weird_thing' } })).toThrow(/\$\.argument2: .*weird_thing/);
    expect(() => p.compile('minecraft:loop')).toThrow(DensityCompileError);
  });

  test('marker wrappers are transparent', () => {
    const p = new DensityProgram(miniBundle({}));
    const n = p.compile({ type: 'minecraft:flat_cache', argument: { type: 'minecraft:cache_2d', argument: 3 } });
    expect(p.nodes[n]).toEqual({ op: 'const', value: 3 });
  });
});

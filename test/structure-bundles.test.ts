// Authored constant-climate datapack inputs, not extracted game JSON. Actual
// 26.2 parity against the official runtime is exercised by the ignored fixtures.
import { expect, test } from 'bun:test';
import { BundleStructureWorker, resolveStructureVersion } from '../src/structures';
import type { StructureBundle, BundleRandomSpreadPlacement } from '../src/structures/bundle-schema';
import type { WorldgenBundle } from '../src/core/bundle';

const workerURL = new URL('../public/structure-worker.js', import.meta.url);
function authoredBundle(): StructureBundle {
  const climate = { temperature: 0, vegetation: 0, continents: 0, erosion: 0, depth: 0, ridges: 0 };
  const parameters = { temperature: 0, humidity: 0, continentalness: 0, erosion: 0, depth: 0, weirdness: 0, offset: 0 };
  const settings = { legacy_random_source: false, noise: { min_y: -64, height: 384 }, noise_router: climate };
  const biomes: WorldgenBundle = {
    format: 1, version: '26.2', noise: {}, density_function: {},
    noise_settings: { overworld: settings, nether: settings, end: settings },
    biome_parameters: {
      overworld: [{ biome: 'minecraft:plains', parameters }],
      nether: [{ biome: 'minecraft:nether_wastes', parameters }],
    },
    dimensions: {
      overworld: { settings: 'overworld', source: { type: 'multi_noise', parameters: 'overworld' } },
      nether: { settings: 'nether', source: { type: 'multi_noise', parameters: 'nether' } },
      end: { settings: 'end', source: { type: 'the_end' } },
    },
  };
  const placement: BundleRandomSpreadPlacement = { type: 'random_spread', salt: 0, locateOffset: [0, 0, 0],
    frequency: 1, frequencyReductionMethod: 'default', spacing: 1, separation: 0, spreadType: 'linear' };
  return { format: 'structure-bundle-1', version: '26.2', biomes,
    structures: {
      'test:land': { id: 'test:land', type: 'test:marker', allowedBiomes: ['minecraft:plains'] },
      'test:nether': { id: 'test:nether', type: 'test:marker', allowedBiomes: ['minecraft:nether_wastes'] },
    },
    sets: {
      'test:mixed': { id: 'test:mixed', placement, structures: [{ structure: 'test:land', weight: 2 }, { structure: 'test:nether', weight: 3 }] },
    },
    presets: { 'minecraft:normal': { overworld: 'overworld', nether: 'nether', end: 'end' } },
  };
}

test('bundle attempts retain dimension-ineligible weighted entries instead of changing the draw', async () => {
  const worker = await BundleStructureWorker.create({ seed: 0n }, { workerURL, bundle: authoredBundle() });
  try {
    const catalog = await worker.execute({ op: 'catalog' });
    const set = catalog.sets.find(s => s.id === 'test:mixed')!;
    expect(set.activeStructures.map(s => s.structure)).toEqual(['test:land']);
    const result = await worker.execute({ op: 'position', set: 'test:mixed', regionX: -3, regionZ: 2 });
    expect(new Set(result.candidate.attemptOrder)).toEqual(new Set(['test:land', 'test:nether']));
    expect([result.candidate.chunkX, result.candidate.chunkZ, result.candidate.blockX, result.candidate.blockZ]).toEqual([-3, 2, -48, 32]);
    const eligibility = await worker.execute({ op: 'biome', structure: 'test:nether', qx: 0, qy: 0, qz: 0 });
    expect([eligibility.biome, eligibility.eligible, eligibility.dimensionPass]).toEqual(['minecraft:plains', false, false]);
  } finally { worker.terminate(); }
});

test('exclusion uses the other set placement and frequency, not just its spacing grid', async () => {
  for (const frequency of [0, 1]) {
    const bundle = authoredBundle();
    const other = bundle.sets['test:mixed']!;
    bundle.sets['test:other'] = { ...other, id: 'test:other', placement: { ...other.placement, frequency } };
    other.placement = { ...other.placement, exclusionZone: { otherSet: 'test:other', chunkCount: 1 } };
    const worker = await BundleStructureWorker.create({ seed: -1n }, { workerURL, bundle });
    try {
      const result = await worker.execute({ op: 'position', set: 'test:mixed', regionX: -1, regionZ: -1 });
      expect(result.candidate.exclusionPass).toBe(frequency === 0);
      expect(result.candidate.placementPass).toBe(frequency === 0);
    } finally { worker.terminate(); }
  }
});

test('frequency zero never supplies a misleading attempt order or accepted placement', async () => {
  const bundle = authoredBundle();
  bundle.sets['test:mixed']!.placement.frequency = 0;
  const worker = await BundleStructureWorker.create({ seed: 9223372036854775807n }, { workerURL, bundle });
  try {
    const result = await worker.execute({ op: 'position', set: 'test:mixed', regionX: 0, regionZ: 0 });
    expect([result.candidate.frequencyPass, result.candidate.placementPass, result.candidate.attemptOrder]).toEqual([false, false, []]);
    expect(() => resolveStructureVersion('26.2')).toThrow(RangeError);
  } finally { worker.terminate(); }
});

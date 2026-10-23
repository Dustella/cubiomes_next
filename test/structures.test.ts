import { describe, expect, test } from 'bun:test';
import { StructureWorker, resolveStructure, resolveStructureVersion } from '../src/structures';

const workerURL = new URL('../public/structure-worker.js', import.meta.url);
const wasm = new Uint8Array(await Bun.file(new URL('../public/structures.wasm', import.meta.url)).arrayBuffer());
const runtime = { workerURL, wasm };

// Uses the actual distributed worker + WASM, with no mocked worker or JS fallback.
describe('Cubiomes structure workers', () => {
  test('1.21.4 is supported without changing the earlier biome cutoff', () => {
    expect(resolveStructureVersion('1.21').id).toBe('1.21.4');
    expect(resolveStructureVersion('1.21.4').mc).toBe(28);
    expect(() => resolveStructureVersion('1.21.5')).toThrow(RangeError);
  });

  test('uniform-grid placements preserve all lower 48 seed bits across negative regions', async () => {
    const a = await StructureWorker.create({ version: '1.21.4', seed: -1n }, runtime);
    const b = await StructureWorker.create({ version: '1.21.4', seed: -1n + (1n << 48n) }, runtime);
    try {
      const request = { op: 'scan' as const, type: resolveStructure('village').id,
        regionX: -3, regionZ: -2, width: 4, height: 3, stage: 'placement' as const };
      const [first, second] = await Promise.all([a.execute(request), b.execute(request)]);
      expect(first).toEqual(second);
      expect(new Set(first.records.map(r => `${r.regionX}/${r.regionZ}`))).toEqual(new Set([
        '-3/-2', '-2/-2', '-1/-2', '0/-2', '-3/-1', '-2/-1', '-1/-1', '0/-1',
        '-3/0', '-2/0', '-1/0', '0/0',
      ]));
      for (const r of first.records) {
        expect(r.position.x).toBeGreaterThanOrEqual(r.regionX * 34 * 16);
        expect(r.position.x).toBeLessThan((r.regionX * 34 + 26) * 16);
        expect(r.position.z).toBeGreaterThanOrEqual(r.regionZ * 34 * 16);
        expect(r.position.z).toBeLessThan((r.regionZ * 34 + 26) * 16);
      }
    } finally { a.terminate(); b.terminate(); }
  });

  test('unsupported generic biome checks remain unknown, never accepted as generated', async () => {
    const worker = await StructureWorker.create({ version: '1.12', seed: 0n }, runtime);
    try {
      const result = await worker.execute({ op: 'scan', type: resolveStructure('feature').id,
        regionX: 0, regionZ: 0, width: 1, height: 1, stage: 'biome', includeRejected: true });
      expect(result.records.map(r => [r.accepted, r.biome])).toEqual([
        [null, { supported: false, raw: null, viable: null }],
      ]);
    } finally { worker.terminate(); }
  });

  test('1.18 fortress fallback and bastion exclusion select exactly one Nether start per region', async () => {
    const worker = await StructureWorker.create({ version: '1.18', seed: 12345n }, runtime);
    try {
      const region = { regionX: -1, regionZ: -1, width: 3, height: 3, stage: 'biome' as const };
      const [fortresses, bastions] = await Promise.all([
        worker.execute({ op: 'scan', type: resolveStructure('fortress').id, ...region }),
        worker.execute({ op: 'scan', type: resolveStructure('bastion').id, ...region }),
      ]);
      const selected = [...fortresses.records, ...bastions.records];
      expect(new Set(selected.map(r => `${r.regionX}/${r.regionZ}`)).size).toBe(9);
      expect(selected.length).toBe(9);
      expect(selected.every(r => r.accepted === true)).toBe(true);
    } finally { worker.terminate(); }
  });

  test('old and new stronghold rings expose finite totals and indexed pagination', async () => {
    for (const [version, total] of [['1.8', 3], ['1.9', 128]] as const) {
      const worker = await StructureWorker.create({ version, seed: 0n }, runtime);
      try {
        const result = await worker.execute({ op: 'strongholds', offset: 1, count: 2 });
        expect(result.total).toBe(total);
        expect(result.records.map(r => r.index)).toEqual([1, 2]);
        expect(result.records[0]!.position).not.toEqual(result.records[1]!.position);
      } finally { worker.terminate(); }
    }
  });

  test('old village house lists and pre-modern End features report unsupported versions explicitly', async () => {
    const worker = await StructureWorker.create({ version: '1.14', seed: 0n }, runtime);
    try {
      const houses = await worker.execute({ op: 'villageHouses', chunkX: 0, chunkZ: 0 });
      expect(houses.supported).toBe(false);
      expect(houses.rngState).toBeNull();
      const checks = await worker.execute({ op: 'check', type: resolveStructure('end_island').id, x: 1600, z: 1600 });
      expect(checks.biome).toEqual({ supported: false, raw: null, viable: null });
    } finally { worker.terminate(); }
  });

  test('piece limits fail instead of returning a truncated fortress layout', async () => {
    const worker = await StructureWorker.create({ version: '1.21.4', seed: 0n }, runtime);
    try {
      const error = await worker.execute({ op: 'pieces', type: resolveStructure('fortress').id, chunkX: -10, chunkZ: 20, maxPieces: 1 }).then(() => null, reason => reason);
      expect(error).toBeInstanceOf(RangeError);
    } finally { worker.terminate(); }
  });

  test('invalid requests reject locally to the worker and termination rejects every pending caller', async () => {
    const worker = await StructureWorker.create({ version: '1.21.4', seed: 0n }, runtime);
    try {
      const invalid = await worker.execute({ op: 'scan', type: 5, regionX: 0, regionZ: 0, width: 0, height: 1 }).then(() => null, reason => reason);
      expect(invalid).toBeInstanceOf(RangeError);
      const first = worker.execute({ op: 'strongholds', count: 128 });
      const second = worker.execute({ op: 'catalog' });
      const outcomes = Promise.allSettled([first, second]);
      worker.terminate();
      const settled = await outcomes;
      expect(settled.map(r => r.status)).toEqual(['rejected', 'rejected']);
      const stopped = await Promise.allSettled([worker.execute({ op: 'catalog' })]);
      expect(stopped[0]!.status).toBe('rejected');
      worker.terminate();
    } finally { worker.terminate(); }
  });
});

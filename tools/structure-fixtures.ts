// Independent native fixture production, not an engine/bridge self-comparison.
// bun tools/structure-fixtures.ts [--oracle executable] [--output file]
// Builds the native oracle when --oracle is omitted; no game assets are used.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  StructureCheck, StructureConfig, StructurePiece, StructurePlacement, StructurePosition,
  StructureRequest, StructureResponse, StructureStronghold, StructureVariant, StructureEndIsland,
} from '../src/structures/types';

interface World { mc: number; seed: string; largeBiomes: boolean }
export interface StructureFixture { world: World; request: StructureRequest; expected: StructureResponse }
interface NativeConfig { salt: number; regionSize: number; chunkRange: number; dimension: number; rarity: number }
interface NativePlacement { regionX: number; regionZ: number; position: StructurePosition; biome: number | null; terrain: number | null }
interface NativeMap {
  catalog: { configs: (NativeConfig | null)[] };
  position: { supported: boolean; position: StructurePosition | null };
  scan: { supported: boolean; records: NativePlacement[] };
  check: { biome: number | null; terrain: number | null };
  featureBiome: { raw: number | null };
  variant: { variant: number[] | null };
  strongholds: { total: number; firstApprox: StructurePosition; records: StructureStronghold[] };
  pieces: { supported: boolean; pieces: StructurePiece[] };
  endIslands: { supported: boolean; islands: StructureEndIsland[]; biome: number | null };
  fixedGateways: { supported: boolean; positions: StructurePosition[] };
  linkedGateway: { supported: boolean; chunk: StructurePosition | null; searchPosition: StructurePosition | null; position: StructurePosition | null };
  villageHouses: { supported: boolean; counts: number[]; rngState: string | null };
  endChunkEmpty: { supported: boolean; empty: boolean | null; bounds: { minX: number; minZ: number; maxX: number; maxZ: number } };
}
type NativeCase = { [K in keyof NativeMap]: { op: K; request: Extract<StructureRequest, { op: K }>; raw: NativeMap[K] } }[keyof NativeMap];
const root = resolve(import.meta.dir, '..');
const args = Bun.argv.slice(2);
const oracleFlag = args.indexOf('--oracle'), outputFlag = args.indexOf('--output');
const oracle = resolve(oracleFlag < 0 ? `${root}/gt-out/structure-oracle${process.platform === 'win32' ? '.exe' : ''}` : args[oracleFlag + 1]!);
const output = resolve(outputFlag < 0 ? `${root}/gt-out/structure-fixtures.json` : args[outputFlag + 1]!);
mkdirSync(resolve(root, 'gt-out'), { recursive: true });
if (oracleFlag < 0) {
  const source = resolve(root, 'vendor/cubiomes');
  const command = [process.env.CC ?? 'gcc', '-std=c11', '-O2', '-fwrapv', '-fno-fast-math', '-ffp-contract=off', '-I', source,
    resolve(root, 'tools/structure-oracle.c'), ...['finders', 'generator', 'layers', 'biomes', 'biomenoise', 'noise'].map(name => resolve(source, `${name}.c`)), '-lm', '-o', oracle];
  const compiler = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
  if (compiler.exitCode !== 0) throw new Error(`Native oracle compilation failed:\n${new TextDecoder().decode(compiler.stderr)}`);
}

const queries: { world: World; request: StructureRequest }[] = [];
function add(world: World, request: StructureRequest): void { queries.push({ world, request }); }
const worlds = Array.from({ length: 26 }, (_, i): World => ({
  mc: i + 3, seed: ['0', '-1', '9223372036854775807', '-9223372036854775808'][i % 4]!, largeBiomes: i + 3 >= 6 && i % 2 === 1,
}));
// Every enum/version combination, including all introduction/configuration boundaries.
for (const world of worlds) add(world, { op: 'catalog' });
const suitableBiomes = [1, 2, 21, 6, 12, 1, 0, 16, 24, 29, 1, 2, 8, 183, 16, 1, 2, 1, 8, 8, 42, 42, 40, 5, 1];
for (const world of worlds) {
  for (let type = 0; type < 25; type++) {
    add(world, { op: 'position', type, regionX: -3, regionZ: 5 });
    add(world, { op: 'check', type, x: -1033, z: 2087, terrain: true });
    add(world, { op: 'featureBiome', type, biome: suitableBiomes[type]! });
    add(world, { op: 'variant', type, x: -1033, z: 2087, biome: suitableBiomes[type]! });
  }
  add(world, { op: 'strongholds', count: world.mc < 12 ? 3 : 8 });
  add(world, { op: 'strongholds', offset: 1, count: 2 });
  add(world, { op: 'fixedGateways' });
  add(world, { op: 'endIslands', chunkX: -91, chunkZ: 83 });
  add(world, { op: 'linkedGateway', x: -96, z: 0 });
  add(world, { op: 'villageHouses', chunkX: -47, chunkZ: 65 });
  add(world, { op: 'endChunkEmpty', chunkX: -91, chunkZ: 83 });
}
// Complete positive/rejected candidate grids at old/new RNG and terrain boundaries.
for (const mc of [3, 11, 12, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]) {
  const world: World = { mc, seed: '-9223372036854775808', largeBiomes: mc % 2 === 0 };
  for (let type = 0; type < 25; type++) {
    const decorator = type === 14 || type === 15 || type === 16 || type === 17 || type === 21 || type === 22;
    add(world, { op: 'scan', type, regionX: decorator ? -64 : -5, regionZ: decorator ? 64 : -5,
      width: decorator ? 64 : 10, height: decorator ? 32 : 10, stage: 'terrain', includeRejected: true });
  }
  add(world, { op: 'pieces', type: 18, chunkX: -47, chunkZ: 65 });
  add(world, { op: 'pieces', type: 20, chunkX: -91, chunkZ: 83 });
}
// Both signed seed extremes, independent ordinary/large worlds, ring transitions.
for (const seed of ['0', '-1', '9223372036854775807', '-9223372036854775808']) {
  for (const largeBiomes of [false, true]) {
    const world = { mc: 28, seed, largeBiomes };
    add(world, { op: 'strongholds', count: 128 });
    for (const type of [1, 2, 3, 4, 5, 8, 11, 12, 13, 17, 19, 24]) {
      for (const biome of type === 5 ? [1, 2, 5, 12, 35, 177] : type === 11 || type === 12 ? [1, 2, 6, 8, 21, 183, 185] : [suitableBiomes[type]!]) {
        add(world, { op: 'variant', type, x: -1631, z: 1057, biome });
      }
    }
    for (const [chunkX, chunkZ] of [[-96, 72], [96, -72], [0, 0], [-1025, -1025]]) {
      add(world, { op: 'endIslands', chunkX: chunkX!, chunkZ: chunkZ! });
      add(world, { op: 'endChunkEmpty', chunkX: chunkX!, chunkZ: chunkZ! });
    }
    for (const [x, z] of [[96, 0], [0, -96], [-77, 56]]) add(world, { op: 'linkedGateway', x: x!, z: z! });
  }
}
// Pale Garden is ID186 in this snapshot; compare actual 1.21.3/1.21.4 predicates.
for (const mc of [27, 28]) {
  const world = { mc, seed: '12345', largeBiomes: false };
  for (let type = 0; type < 25; type++) add(world, { op: 'featureBiome', type, biome: 186 });
}

function argumentsFor(request: StructureRequest): number[] {
  switch (request.op) {
    case 'catalog': return [0, 0];
    case 'position': return [1, request.type, request.regionX, request.regionZ];
    case 'scan': return [2, request.type, request.regionX, request.regionZ, request.width, request.height,
      request.stage === 'terrain' ? 2 : request.stage === 'biome' ? 1 : 0, +(request.includeRejected ?? false), request.flags ?? 0];
    case 'check': return [3, request.type, request.x, request.z, request.flags ?? 0, +(request.terrain ?? false)];
    case 'featureBiome': return [4, request.type, request.biome];
    case 'variant': return [5, request.type, request.x, request.z, request.biome ?? -1];
    case 'strongholds': return [6, 0, request.offset ?? 0, request.count ?? 0];
    case 'pieces': return [7, request.type, request.chunkX, request.chunkZ, request.maxPieces ?? 4096];
    case 'endIslands': return [8, 0, request.chunkX, request.chunkZ];
    case 'fixedGateways': return [9, 0];
    case 'linkedGateway': return [10, 0, request.x, request.z];
    case 'villageHouses': return [11, 0, request.chunkX, request.chunkZ];
    case 'endChunkEmpty': return [12, 0, request.chunkX, request.chunkZ];
  }
}
async function nativeBatch(batch: { world: World; request: StructureRequest }[]): Promise<string[]> {
  const input = batch.map(({ world, request }) => [world.mc, world.seed, +world.largeBiomes, ...argumentsFor(request)].join(' ')).join('\n') + '\n';
  const proc = Bun.spawn([oracle, '--batch'], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (status !== 0) throw new Error(`Native oracle failed (${status}): ${stderr}`);
  const lines = stdout.trimEnd().split(/\r?\n/);
  if (lines.length !== batch.length) throw new Error(`Native oracle returned ${lines.length}/${batch.length} complete records`);
  return lines;
}
const lines = await nativeBatch(queries);
const configs = new Map<number, StructureConfig[]>();
function knownFields(type: number, mc: number): string[] {
  switch (type) {
    case 5: return mc < 17 ? ['abandoned'] : ['abandoned', 'biome', 'start', 'rotation', 'x', 'z', 'sx', 'sy', 'sz'];
    case 19: return ['start', 'rotation', 'x', 'z', 'sx', 'sy', 'sz'];
    case 13: case 24: return ['start', 'rotation', 'x', 'y', 'z', 'sx', 'sy', 'sz'];
    case 11: case 12: return ['biome', 'underground', 'airpocket', 'giant', 'start', 'rotation', 'mirror'];
    case 8: return ['x', 'z', 'sx', 'sz'];
    case 4: return ['basement', 'size', 'rotation', 'mirror', 'sx', 'sy', 'sz'];
    case 1: case 2: case 3: return mc < 25 ? ['sx', 'sy', 'sz'] : ['rotation', 'mirror', 'sx', 'sy', 'sz'];
    case 17: return ['x', 'y', 'z', 'size', 'cracked'];
    default: return [];
  }
}
function checked(raw: number | null): StructureCheck { return { supported: raw !== null, raw, viable: raw === null ? null : raw !== 0 }; }
function normalize(entry: NativeCase, mc: number): StructureResponse {
  const config = (type: number) => configs.get(mc)![type]!;
  switch (entry.op) {
    case 'catalog': {
      const structures: StructureConfig[] = entry.raw.configs.map((raw, type) => {
        const supported = raw !== null;
        const dimension = [12, 18, 19].includes(type) ? -1 : [20, 21, 22].includes(type) ? 1 : 0;
        const variantSupported = supported && ([1, 2, 3, 4, 8, 11, 12, 13, 17, 19, 24].includes(type) || type === 5 && mc >= 13);
        return { type, supported, salt: raw?.salt ?? null, regionSize: raw?.regionSize ?? null,
          chunkRange: raw?.chunkRange ?? null, rarity: raw?.rarity ?? null, dimension,
          biomeSupported: supported && type !== 0 && type !== 22,
          featureBiomeSupported: supported && type !== 0 && type !== 17 && type !== 22,
          terrain: !supported || type === 0 || dimension !== 0 && type !== 20 ? 'unsupported' : type === 20 ? 'end-surface' : mc >= 22 && [1, 2, 9].includes(type) ? 'approximate' : 'not-required',
          variantSupported, variantRequiresBiome: variantSupported && [5, 11, 12].includes(type) };
      });
      configs.set(mc, structures); return { op: 'catalog', structures };
    }
    case 'position': return { op: 'position', type: entry.request.type, ...entry.raw };
    case 'scan': {
      const request = entry.request, stage = request.stage ?? 'placement', cfg = config(request.type);
      const records: StructurePlacement[] = entry.raw.records.map(record => {
        const biome = stage === 'placement' ? null : checked(record.biome);
        const terrain = stage !== 'terrain' || !biome?.viable ? null : checked(record.terrain);
        const accepted = stage === 'placement' ? true : !biome?.supported ? null : !biome.viable ? false : stage === 'biome' ? true : !terrain?.supported ? null : terrain.viable;
        return { ...record, biome, terrain, accepted };
      }).filter(record => request.includeRejected || record.accepted === true);
      return { op: 'scan', type: request.type, supported: entry.raw.supported, stage, terrainMode: cfg.terrain, records };
    }
    case 'check': return { op: 'check', type: entry.request.type, biome: checked(entry.raw.biome), terrain: entry.request.terrain ? checked(entry.raw.terrain) : null, terrainMode: config(entry.request.type).terrain };
    case 'featureBiome': return { op: 'featureBiome', type: entry.request.type, biome: entry.request.biome, check: checked(entry.raw.raw) };
    case 'variant': {
      const values = entry.raw.variant;
      let variant: StructureVariant | null = null;
      if (values) {
        const [abandoned, giant, underground, airpocket, basement, cracked, size, start, biome, rotation, mirror, x, y, z, sx, sy, sz] = values;
        variant = { abandoned: !!abandoned, giant: !!giant, underground: !!underground, airpocket: !!airpocket,
          basement: !!basement, cracked: !!cracked, size: size!, start: start!, biome: biome!, rotation: rotation!, mirror: mirror!,
          x: x!, y: y!, z: z!, sx: sx!, sy: sy!, sz: sz!, knownFields: knownFields(entry.request.type, mc) };
      }
      return { op: 'variant', type: entry.request.type, supported: config(entry.request.type).variantSupported, variant };
    }
    case 'strongholds': return { op: 'strongholds', ...entry.raw };
    case 'pieces': return { op: 'pieces', type: entry.request.type, ...entry.raw };
    case 'endIslands': return { op: 'endIslands', ...entry.raw, biomeViable: entry.raw.biome === null ? null : entry.raw.biome === 40 };
    case 'fixedGateways': return { op: 'fixedGateways', ...entry.raw };
    case 'linkedGateway': return { op: 'linkedGateway', ...entry.raw };
    case 'villageHouses': return { op: 'villageHouses', ...entry.raw };
    case 'endChunkEmpty': return { op: 'endChunkEmpty', ...entry.raw };
  }
}
const fixtures: StructureFixture[] = queries.map(({ world, request }, index) => {
  // Trusted local native protocol: discriminant is supplied by the corresponding query.
  const entry = { op: request.op, request, raw: JSON.parse(lines[index]!) } as NativeCase;
  return { world, request, expected: normalize(entry, world.mc) };
});
// Seeded arbitrary chunks can all miss the rarity gate. Discover real native
// candidates, then retain explicit witnesses for each island-generation branch.
const islandVersions = [16, 20, 21, 22, 28];
const islandQueries: { world: World; request: Extract<StructureRequest, { op: 'endIslands' }> }[] = [];
for (const fixture of fixtures) {
  if (fixture.request.op !== 'scan' || fixture.request.type !== 22 || fixture.expected.op !== 'scan' || !islandVersions.includes(fixture.world.mc)) continue;
  for (const candidate of fixture.expected.records) {
    islandQueries.push({ world: fixture.world, request: { op: 'endIslands', chunkX: candidate.regionX, chunkZ: candidate.regionZ } });
  }
}
const islandLines = await nativeBatch(islandQueries);
const islandCandidates: StructureFixture[] = islandQueries.map(({ world, request }, index) => {
  const raw = JSON.parse(islandLines[index]!) as NativeMap['endIslands'];
  return { world, request, expected: { op: 'endIslands', ...raw, biomeViable: raw.biome === null ? null : raw.biome === 40 } };
});
for (const mc of islandVersions) {
  const candidates = islandCandidates.filter(fixture => fixture.world.mc === mc);
  const retained = new Set(candidates.slice(0, 8));
  for (const count of [1, 2]) {
    const witness = candidates.find(fixture => fixture.expected.op === 'endIslands' && fixture.expected.islands.length === count);
    if (!witness) throw new Error(`Native island fixture discovery found no ${count}-island witness for mc=${mc}`);
    retained.add(witness);
  }
  const biomeWitness = candidates.find(fixture => fixture.expected.op === 'endIslands' && fixture.expected.islands.length > 0 && fixture.expected.biomeViable);
  if (!biomeWitness) throw new Error(`Native island fixture discovery found no viable-biome witness for mc=${mc}`);
  retained.add(biomeWitness);
  fixtures.push(...retained);
}
await Bun.write(output, JSON.stringify(fixtures));
console.log(JSON.stringify({ oracle, output, cases: fixtures.length, versions: worlds.length, operations: [...new Set(queries.map(q => q.request.op))] }));

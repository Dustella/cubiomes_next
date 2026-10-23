// Reads user-supplied registry JSON only. Derived bundles are local, ignored assets.
// bun tools/make-structure-bundle.ts --data ../official_source/26.2/gen/data/minecraft --biomes bundles/26.2.bundle.json --out bundles/26.2.structures.bundle.json
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { qualify, validateBundle } from '../src/core/bundle';
import type { BundleDimension, BundlePlacement, BundleStructureSet, StructureBundle } from '../src/structures/bundle-schema';

type Json = Record<string, any>;
const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i += 2) {
  if (!Bun.argv[i]!.startsWith('--') || !Bun.argv[i + 1]) throw new Error('Expected --data, --biomes and --out paths');
  args.set(Bun.argv[i]!.slice(2), Bun.argv[i + 1]!);
}
const root = args.get('data'), biomePath = args.get('biomes'), out = args.get('out');
if (!root || !biomePath || !out) throw new Error('--data, --biomes and --out are required');
function registry(path: string): Map<string, Json> {
  const result = new Map<string, Json>();
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) visit(file);
      else if (name.endsWith('.json')) result.set(qualify(relative(path, file).replaceAll('\\', '/').slice(0, -5)), JSON.parse(readFileSync(file, 'utf8')));
    }
  };
  if (!existsSync(path)) throw new Error(`Missing registry directory ${path}`);
  visit(path);
  return result;
}
const biomes = validateBundle(JSON.parse(readFileSync(biomePath, 'utf8')));
if (biomes.version !== '26.2') throw new Error('Biome bundle must be version 26.2');
const tags = registry(join(root, 'tags', 'worldgen', 'biome'));
const resolved = new Map<string, string[]>();
function tag(id: string, visiting = new Set<string>()): string[] {
  id = qualify(id);
  const cached = resolved.get(id);
  if (cached) return cached;
  if (visiting.has(id)) throw new Error(`Cyclic biome tag ${id}`);
  const data = tags.get(id);
  if (!data) throw new Error(`Missing biome tag ${id}`);
  visiting.add(id);
  const values = new Set<string>();
  for (const entry of data.values) {
    const value = typeof entry === 'string' ? entry : entry.id;
    if (typeof value !== 'string') throw new Error(`Invalid biome tag entry ${id}`);
    if (value.startsWith('#')) {
      if (typeof entry === 'object' && entry.required === false && !tags.has(qualify(value.slice(1)))) continue;
      for (const biome of tag(value.slice(1), visiting)) values.add(biome);
    } else values.add(qualify(value));
  }
  visiting.delete(id);
  const result = [...values].sort();
  resolved.set(id, result);
  return result;
}
function biomeList(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('#') ? tag(value.slice(1)) : [qualify(value)];
  if (Array.isArray(value)) return [...new Set(value.flatMap(biomeList))].sort();
  throw new Error('Expected a biome holder set');
}
const structures: StructureBundle['structures'] = {};
for (const [id, data] of registry(join(root, 'worldgen', 'structure'))) {
  structures[id] = { id, type: qualify(data.type), allowedBiomes: biomeList(data.biomes) };
}
const sets: StructureBundle['sets'] = {};
for (const [id, data] of registry(join(root, 'worldgen', 'structure_set'))) {
  const p = data.placement;
  const common = {
    salt: p.salt, locateOffset: p.locate_offset ?? [0, 0, 0], frequency: p.frequency ?? 1,
    frequencyReductionMethod: p.frequency_reduction_method ?? 'default',
    ...(p.exclusion_zone ? { exclusionZone: { otherSet: qualify(p.exclusion_zone.other_set), chunkCount: p.exclusion_zone.chunk_count } } : {}),
  };
  let placement: BundlePlacement;
  if (qualify(p.type) === 'minecraft:random_spread') {
    placement = { ...common, type: 'random_spread', spacing: p.spacing, separation: p.separation, spreadType: p.spread_type ?? 'linear' };
  } else if (qualify(p.type) === 'minecraft:concentric_rings') {
    placement = { ...common, type: 'concentric_rings', distance: p.distance, spread: p.spread, count: p.count, preferredBiomes: biomeList(p.preferred_biomes) };
  } else throw new Error(`Unsupported placement type ${p.type}`);
  const entries = data.structures.map((entry: Json) => ({ structure: qualify(entry.structure), weight: entry.weight }));
  for (const entry of entries) if (!structures[entry.structure]) throw new Error(`Missing structure ${entry.structure}`);
  sets[id] = { id, placement, structures: entries } satisfies BundleStructureSet;
}
const presets: StructureBundle['presets'] = {};
const dimensionNames: Record<string, BundleDimension> = { 'minecraft:overworld': 'overworld', 'minecraft:the_nether': 'nether', 'minecraft:the_end': 'end' };
for (const [id, preset] of registry(join(root, 'worldgen', 'world_preset'))) {
  const dimensions: Partial<Record<BundleDimension, string>> = {};
  for (const [dimensionId, data] of Object.entries(preset.dimensions) as [string, Json][]) {
    const dimension = dimensionNames[dimensionId];
    if (!dimension) continue;
    const generator = data.generator;
    if (generator.type !== 'minecraft:noise' || typeof generator.settings !== 'string') continue;
    const settings = generator.settings.replace(/^minecraft:/, '');
    const source = generator.biome_source;
    const match = Object.entries(biomes.dimensions).find(([, model]) => model.settings === settings && (
      (source.type === 'minecraft:the_end' && model.source.type === 'the_end') ||
      (source.type === 'minecraft:multi_noise' && model.source.type === 'multi_noise' && qualify(model.source.parameters) === source.preset)
    ));
    if (match) dimensions[dimension] = match[0];
  }
  if (Object.keys(dimensions).length) presets[id] = dimensions;
}
const bundle: StructureBundle = { format: 'structure-bundle-1', version: '26.2', biomes, structures, sets, presets };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(bundle));
console.log(`wrote ${out}: ${Object.keys(sets).length} sets, ${Object.keys(structures).length} structures; presets ${Object.keys(presets).join(', ')}`);

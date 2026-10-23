import { validateBundle } from '../core/bundle';
import type { StructureBundle } from './bundle-schema';

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}
export function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
  return value;
}
function id(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value)) throw new TypeError(`${name} must be a namespaced registry ID`);
}
function ids(value: unknown, name: string): void {
  if (!Array.isArray(value) || value.length > 65536) throw new TypeError(`${name} must be a bounded list of IDs`);
  for (const entry of value) id(entry, name);
}
export function validateStructureBundle(value: unknown): StructureBundle {
  const b = record(value, 'structure bundle');
  if (b.format !== 'structure-bundle-1' || b.version !== '26.2') throw new TypeError('Expected a 26.2 structure-bundle-1 bundle');
  const biomeBundle = validateBundle(b.biomes);
  if (biomeBundle.version !== '26.2') throw new TypeError('Structure and biome bundle versions must both be 26.2');
  const structures = record(b.structures, 'structures'), sets = record(b.sets, 'sets'), presets = record(b.presets, 'presets');
  if (!Object.keys(sets).length || Object.keys(sets).length > 4096 || Object.keys(structures).length > 65536) throw new RangeError('Structure bundle registry sizes are out of bounds');
  for (const [key, value] of Object.entries(structures)) {
    id(key, 'structure key');
    const structure = record(value, key);
    if (structure.id !== key) throw new TypeError(`Mismatched structure ID ${key}`);
    id(structure.type, `${key}.type`);
    ids(structure.allowedBiomes, `${key}.allowedBiomes`);
  }
  for (const [key, value] of Object.entries(sets)) {
    id(key, 'set key');
    const set = record(value, key), p = record(set.placement, `${key}.placement`);
    if (set.id !== key) throw new TypeError(`Mismatched set ID ${key}`);
    if (!Array.isArray(set.structures) || !set.structures.length || set.structures.length > 4096) throw new TypeError(`Invalid weighted entries for ${key}`);
    let weight = 0;
    for (const value of set.structures) {
      const entry = record(value, 'weighted entry');
      id(entry.structure, 'weighted structure');
      if (!Object.hasOwn(structures, entry.structure)) throw new TypeError(`Missing structure ${entry.structure}`);
      weight += integer(entry.weight, 'weight', 1, 0x7fffffff);
      if (weight > 0x7fffffff) throw new RangeError('Total structure weight exceeds INT32_MAX');
    }
    integer(p.salt, 'salt', 0, 0x7fffffff);
    if (typeof p.frequency !== 'number' || !Number.isFinite(p.frequency) || p.frequency < 0 || p.frequency > 1) throw new RangeError('frequency must be in [0, 1]');
    if (!['default', 'legacy_type_1', 'legacy_type_2', 'legacy_type_3'].includes(p.frequencyReductionMethod as string)) throw new TypeError('Unknown frequency reduction method');
    if (!Array.isArray(p.locateOffset) || p.locateOffset.length !== 3) throw new TypeError('locateOffset must have three coordinates');
    for (const value of p.locateOffset) integer(value, 'locateOffset', -16, 16);
    if (p.type === 'random_spread') {
      const spacing = integer(p.spacing, 'spacing', 1, 4096);
      integer(p.separation, 'separation', 0, spacing - 1);
      if (p.spreadType !== 'linear' && p.spreadType !== 'triangular') throw new TypeError('Unknown spreadType');
    } else if (p.type === 'concentric_rings') {
      integer(p.distance, 'distance', 0, 1023); integer(p.spread, 'spread', 1, 1023); integer(p.count, 'count', 0, 4095);
      if ((p.count as number) > 128) throw new RangeError('This runtime supports at most 128 concentric ring positions');
      ids(p.preferredBiomes, 'preferredBiomes');
    } else throw new TypeError('Unknown placement type');
    if (p.exclusionZone !== undefined) {
      const zone = record(p.exclusionZone, 'exclusionZone');
      id(zone.otherSet, 'otherSet');
      if (!Object.hasOwn(sets, zone.otherSet)) throw new TypeError(`Missing exclusion set ${zone.otherSet}`);
      integer(zone.chunkCount, 'chunkCount', 1, 16);
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(key: string): void {
    if (visiting.has(key)) throw new TypeError('Cyclic structure exclusion zones');
    if (visited.has(key)) return;
    visiting.add(key);
    const next = (sets[key] as StructureBundle['sets'][string]).placement.exclusionZone?.otherSet;
    if (next) visit(next);
    visiting.delete(key); visited.add(key);
  }
  for (const key of Object.keys(sets)) visit(key);
  for (const [key, value] of Object.entries(presets)) {
    id(key, 'preset');
    const dimensions = record(value, 'preset dimensions');
    for (const [dimension, model] of Object.entries(dimensions)) {
      if (!['overworld', 'nether', 'end'].includes(dimension) || typeof model !== 'string' || !Object.hasOwn(biomeBundle.dimensions, model)) throw new TypeError(`Invalid preset dimension ${key}.${dimension}`);
    }
  }
  return value as StructureBundle;
}

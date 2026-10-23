import { SUPPORTED_VERSIONS, type Dimension, type MinecraftVersion } from '../versions';

/** Cubiomes StructureType IDs. Feature is its pre-1.13 shared attempt grid,
 * not an additional generated building. Strongholds have a separate ring API.
 */
export const STRUCTURES = Object.freeze(([
  { id: 0, kind: 'feature', dimension: 'overworld' },
  { id: 1, kind: 'desert_pyramid', dimension: 'overworld' },
  { id: 2, kind: 'jungle_temple', dimension: 'overworld' },
  { id: 3, kind: 'swamp_hut', dimension: 'overworld' },
  { id: 4, kind: 'igloo', dimension: 'overworld' },
  { id: 5, kind: 'village', dimension: 'overworld' },
  { id: 6, kind: 'ocean_ruin', dimension: 'overworld' },
  { id: 7, kind: 'shipwreck', dimension: 'overworld' },
  { id: 8, kind: 'monument', dimension: 'overworld' },
  { id: 9, kind: 'mansion', dimension: 'overworld' },
  { id: 10, kind: 'outpost', dimension: 'overworld' },
  { id: 11, kind: 'ruined_portal', dimension: 'overworld' },
  { id: 12, kind: 'ruined_portal_nether', dimension: 'nether' },
  { id: 13, kind: 'ancient_city', dimension: 'overworld' },
  { id: 14, kind: 'buried_treasure', dimension: 'overworld' },
  { id: 15, kind: 'mineshaft', dimension: 'overworld' },
  { id: 16, kind: 'desert_well', dimension: 'overworld' },
  { id: 17, kind: 'geode', dimension: 'overworld' },
  { id: 18, kind: 'fortress', dimension: 'nether' },
  { id: 19, kind: 'bastion', dimension: 'nether' },
  { id: 20, kind: 'end_city', dimension: 'end' },
  { id: 21, kind: 'end_gateway', dimension: 'end' },
  { id: 22, kind: 'end_island', dimension: 'end' },
  { id: 23, kind: 'trail_ruins', dimension: 'overworld' },
  { id: 24, kind: 'trial_chambers', dimension: 'overworld' },
] as const).map(value => Object.freeze(value)));

export type StructureKind = (typeof STRUCTURES)[number]['kind'];
export type StructureDescriptor = { readonly id: number; readonly kind: StructureKind; readonly dimension: Dimension };

const byKind: Readonly<Record<string, StructureDescriptor>> = Object.fromEntries(STRUCTURES.map(s => [s.kind, s]));
export function resolveStructure(kind: StructureKind): StructureDescriptor {
  const value = Object.hasOwn(byKind, kind) ? byKind[kind] : undefined;
  if (!value) throw new RangeError(`Unknown structure "${kind}"`);
  return value;
}

/** Structure APIs include Winter Drop. The existing biome release resolver
 * deliberately retains its earlier <1.21.4 cutoff and alias semantics.
 */
export const STRUCTURE_VERSIONS: readonly MinecraftVersion[] = Object.freeze([
  ...SUPPORTED_VERSIONS,
  Object.freeze({ id: '1.21.4', mc: 28, major: '1.21' }),
]);
const versions = new Map<string, MinecraftVersion>();
for (const v of STRUCTURE_VERSIONS) {
  versions.set(v.id, v);
  versions.set(v.major, v);
}
export function resolveStructureVersion(version: string): MinecraftVersion {
  const value = versions.get(version);
  if (!value) throw new RangeError(`Unsupported structure version "${version}"; supported release range is 1.0–1.21.4`);
  return value;
}

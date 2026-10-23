export interface ViewWorld { version: string; dimension: 'overworld' | 'nether' | 'end'; seed: bigint; y: number }
/** Horizontal coordinates and step are in quarts; world.y is in blocks. */
export interface ViewRegion { x0: number; z0: number; w: number; h: number; step: number }
export interface ViewLayer { id: string; label: string; color: string; detail: string }
/** Marker positions are block coordinates. */
export interface ViewMarker { id: string; layer: string; label: string; x: number; z: number; detail: string }
export interface ViewFrame { biomes: Uint32Array; names: string[]; gpuMs: number | null; backend: string }
export interface ViewVersion { id: string; label: string }

export interface ViewerCpuRequest { id: number; world: ViewWorld; region: ViewRegion; bundleURL?: string }
export type ViewerCpuReply =
  | { id: number; ok: true; biomes: Uint32Array; names: string[] }
  | { id: number; ok: false; message: string };

// Numeric identifiers from vendor/cubiomes/biomes.h (MIT, Cubitect).
// Preserve pre-1.18 names for retired biomes; use the modern aliases thereafter.
const BASE_NAMES = [
  'ocean', 'plains', 'desert', 'mountains', 'forest', 'taiga', 'swamp', 'river', 'nether_wastes', 'the_end',
  'frozen_ocean', 'frozen_river', 'snowy_tundra', 'snowy_mountains', 'mushroom_fields', 'mushroom_field_shore',
  'beach', 'desert_hills', 'wooded_hills', 'taiga_hills', 'mountain_edge', 'jungle', 'jungle_hills', 'jungle_edge',
  'deep_ocean', 'stone_shore', 'snowy_beach', 'birch_forest', 'birch_forest_hills', 'dark_forest', 'snowy_taiga',
  'snowy_taiga_hills', 'giant_tree_taiga', 'giant_tree_taiga_hills', 'wooded_mountains', 'savanna', 'savanna_plateau',
  'badlands', 'wooded_badlands_plateau', 'badlands_plateau', 'small_end_islands', 'end_midlands', 'end_highlands',
  'end_barrens', 'warm_ocean', 'lukewarm_ocean', 'cold_ocean', 'deep_warm_ocean', 'deep_lukewarm_ocean',
  'deep_cold_ocean', 'deep_frozen_ocean', 'seasonal_forest', 'rainforest', 'shrubland',
];
const EXTRA_NAMES: Record<number, string> = {
  127: 'the_void', 129: 'sunflower_plains', 130: 'desert_lakes', 131: 'gravelly_mountains', 132: 'flower_forest',
  133: 'taiga_mountains', 134: 'swamp_hills', 140: 'ice_spikes', 149: 'modified_jungle', 151: 'modified_jungle_edge',
  155: 'tall_birch_forest', 156: 'tall_birch_hills', 157: 'dark_forest_hills', 158: 'snowy_taiga_mountains',
  160: 'giant_spruce_taiga', 161: 'giant_spruce_taiga_hills', 162: 'modified_gravelly_mountains',
  163: 'shattered_savanna', 164: 'shattered_savanna_plateau', 165: 'eroded_badlands',
  166: 'modified_wooded_badlands_plateau', 167: 'modified_badlands_plateau', 168: 'bamboo_jungle',
  169: 'bamboo_jungle_hills', 170: 'soul_sand_valley', 171: 'crimson_forest', 172: 'warped_forest',
  173: 'basalt_deltas', 174: 'dripstone_caves', 175: 'lush_caves', 177: 'meadow', 178: 'grove', 179: 'snowy_slopes',
  180: 'jagged_peaks', 181: 'frozen_peaks', 182: 'stony_peaks', 183: 'deep_dark', 184: 'mangrove_swamp',
  185: 'cherry_grove', 186: 'pale_garden',
};
const MODERN_NAMES: Record<number, string> = {
  3: 'windswept_hills', 12: 'snowy_plains', 23: 'sparse_jungle', 25: 'stony_shore', 32: 'old_growth_pine_taiga',
  34: 'windswept_forest', 38: 'wooded_badlands', 131: 'windswept_gravelly_hills',
  155: 'old_growth_birch_forest', 160: 'old_growth_spruce_taiga', 163: 'windswept_savanna',
};
export function cubiomesNames(mc: number): string[] {
  const names = Array.from({ length: 256 }, (_, id) => `cubiomes:biome_${id}`);
  BASE_NAMES.forEach((name, id) => { names[id] = `minecraft:${name}`; });
  for (const [id, name] of Object.entries(EXTRA_NAMES)) names[Number(id)] = `minecraft:${name}`;
  if (mc >= 22) for (const [id, name] of Object.entries(MODERN_NAMES)) names[Number(id)] = `minecraft:${name}`;
  return names;
}

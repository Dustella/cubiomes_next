// Biome map colours, keyed by resource id. Palette follows cubiomes-viewer's
// AMIDST-derived scheme; unknown biomes (e.g. from a future bundle) get a
// stable hash colour so new versions render without code changes.

export const BIOME_COLORS: Record<string, number> = {
  ocean: 0x000070, plains: 0x8db360, desert: 0xfa9418, windswept_hills: 0x606060, forest: 0x056621,
  taiga: 0x0b6a5f, swamp: 0x07f9b2, river: 0x0000ff, nether_wastes: 0x572526, the_end: 0x8080ff,
  frozen_ocean: 0x7070d6, frozen_river: 0xa0a0ff, snowy_plains: 0xffffff, mushroom_fields: 0xff00ff,
  beach: 0xfade55, jungle: 0x507b0a, sparse_jungle: 0x60930f, deep_ocean: 0x000030, stony_shore: 0xa2a284,
  snowy_beach: 0xfaf0c0, birch_forest: 0x307444, dark_forest: 0x40511a, snowy_taiga: 0x31554a,
  old_growth_pine_taiga: 0x596651, windswept_forest: 0x5b7352, savanna: 0xbdb25f, savanna_plateau: 0xa79d64,
  badlands: 0xd94515, wooded_badlands: 0xb09765, small_end_islands: 0x4b4bab, end_midlands: 0xc9c959,
  end_highlands: 0xb5b536, end_barrens: 0x7070cc, warm_ocean: 0x0000ac, lukewarm_ocean: 0x000090,
  cold_ocean: 0x202070, deep_lukewarm_ocean: 0x000040, deep_cold_ocean: 0x202038, deep_frozen_ocean: 0x404090,
  the_void: 0x000000, sunflower_plains: 0xb5db88, windswept_gravelly_hills: 0x888888, flower_forest: 0x2d8e49,
  ice_spikes: 0xb4dcdc, old_growth_birch_forest: 0x589c6c, old_growth_spruce_taiga: 0x818e79,
  windswept_savanna: 0xe5da87, eroded_badlands: 0xff6d3d, bamboo_jungle: 0x849500, soul_sand_valley: 0x4d3a2e,
  crimson_forest: 0x981a11, warped_forest: 0x49907b, basalt_deltas: 0x645f63, dripstone_caves: 0x4e3012,
  lush_caves: 0x283c00, meadow: 0x60a445, grove: 0x47726c, snowy_slopes: 0xc4c4c4, jagged_peaks: 0xdcdcc8,
  frozen_peaks: 0xb0b3ce, stony_peaks: 0x7b8f74, deep_dark: 0x031f29, mangrove_swamp: 0x2ccc8e,
  cherry_grove: 0xff91c8, pale_garden: 0x696d95,
  // 26.x
  sulfur_caves: 0xc8b432,
};

/** RGB for a biome id like `minecraft:plains`. */
export function biomeColor(id: string): number {
  const key = id.replace(/^minecraft:/, '');
  const c = BIOME_COLORS[key];
  if (c !== undefined) return c;
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 8) & 0xffffff;
}

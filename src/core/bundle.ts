// Worldgen bundle: the version-specific data the generator consumes.
// Produced by tools/make-bundle.ts from a user-supplied server jar (or edited
// by hand / datapacks). Nothing in here is hard-coded per Minecraft version.

export type DensityJson = number | string | { type: string; [key: string]: unknown };

export interface NoiseJson {
  firstOctave: number;
  amplitudes: number[];
}

export interface ParameterJson {
  temperature: number | [number, number];
  humidity: number | [number, number];
  continentalness: number | [number, number];
  erosion: number | [number, number];
  depth: number | [number, number];
  weirdness: number | [number, number];
  offset: number;
}

export interface BiomeEntryJson {
  biome: string;
  parameters: ParameterJson;
}

export const CLIMATE_FIELDS = ['temperature', 'vegetation', 'continents', 'erosion', 'depth', 'ridges'] as const;
export type ClimateField = (typeof CLIMATE_FIELDS)[number];

export interface NoiseSettingsJson {
  legacy_random_source: boolean;
  noise: { min_y: number; height: number };
  noise_router: Record<ClimateField, DensityJson>;
}

export interface DimensionJson {
  /** Key into noise_settings. */
  settings: string;
  /** `multi_noise` uses biome_parameters[parameters]; `the_end` uses the fixed End source. */
  source: { type: 'multi_noise'; parameters: string } | { type: 'the_end' };
}

/**
 * Noises that legacy-random-source settings construct differently from their
 * JSON definition (game code, not data). Each is seeded sequentially from
 * `seed + seed_offset` with `noise` params; `zero: true` makes it constant 0.
 */
export interface LegacyNoiseOverride {
  seed_offset?: number;
  noise?: NoiseJson;
  zero?: boolean;
}

export interface WorldgenBundle {
  format: 1;
  version: string;
  noise: Record<string, NoiseJson>;
  density_function: Record<string, DensityJson>;
  noise_settings: Record<string, NoiseSettingsJson>;
  biome_parameters: Record<string, BiomeEntryJson[]>;
  dimensions: Record<string, DimensionJson>;
  legacy_noise_overrides?: Record<string, LegacyNoiseOverride>;
}

/** Normalises `foo` to `minecraft:foo`. */
export function qualify(id: string): string {
  return id.includes(':') ? id : `minecraft:${id}`;
}

export function validateBundle(value: unknown): WorldgenBundle {
  if (!value || typeof value !== 'object') throw new Error('bundle: not an object');
  const b = value as Record<string, unknown>;
  if (b.format !== 1) throw new Error(`bundle: unsupported format ${String(b.format)}`);
  for (const key of ['noise', 'density_function', 'noise_settings', 'biome_parameters', 'dimensions'] as const) {
    if (!b[key] || typeof b[key] !== 'object') throw new Error(`bundle: missing "${key}"`);
  }
  // Shape validated at the boundary; nested parts are checked lazily by the
  // compiler, which reports the exact offending node.
  const bundle = value as WorldgenBundle;
  for (const [name, dim] of Object.entries(bundle.dimensions)) {
    if (!bundle.noise_settings[dim.settings]) throw new Error(`bundle: dimension ${name} references missing noise_settings ${dim.settings}`);
    if (dim.source.type === 'multi_noise' && !bundle.biome_parameters[dim.source.parameters]) {
      throw new Error(`bundle: dimension ${name} references missing biome_parameters ${dim.source.parameters}`);
    }
  }
  return bundle;
}

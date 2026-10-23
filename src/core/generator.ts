// CPU biome generator built entirely from a WorldgenBundle.

import { CLIMATE_FIELDS, validateBundle, type DimensionJson, type WorldgenBundle } from './bundle';
import { buildClimateIndex, quantize, searchClimate, type ClimateIndex } from './climate';
import { DensityProgram } from './density';
import { endBiome } from './end';
import { evaluate, NoiseSet } from './evaluate';

/** Compiled, seed-independent form of one dimension. */
export class DimensionModel {
  readonly program: DensityProgram;
  /** Node index per climate field, in CLIMATE_FIELDS order. */
  readonly roots: number[];
  readonly legacy: boolean;
  readonly index: ClimateIndex | null;
  readonly biomes: string[];

  constructor(readonly bundle: WorldgenBundle, readonly dimension: DimensionJson) {
    const settings = bundle.noise_settings[dimension.settings]!;
    this.legacy = settings.legacy_random_source;
    this.program = new DensityProgram(bundle);
    this.roots = CLIMATE_FIELDS.map((f) => this.program.compile(settings.noise_router[f], `${dimension.settings}.noise_router.${f}`));
    if (dimension.source.type === 'multi_noise') {
      this.index = buildClimateIndex(bundle.biome_parameters[dimension.source.parameters]!);
      this.biomes = this.index.biomes;
    } else {
      this.index = null;
      this.biomes = ['minecraft:the_end', 'minecraft:end_highlands', 'minecraft:end_midlands', 'minecraft:small_end_islands', 'minecraft:end_barrens'];
    }
  }

  static fromBundle(json: unknown, dimension: string): DimensionModel {
    const bundle = validateBundle(json);
    const dim = bundle.dimensions[dimension];
    if (!dim) throw new Error(`bundle has no dimension "${dimension}"`);
    return new DimensionModel(bundle, dim);
  }
}

export class BiomeGenerator {
  readonly noises: NoiseSet;
  private readonly scratch: Float64Array;
  private readonly target = new Float64Array(7);

  constructor(readonly model: DimensionModel, readonly seed: bigint) {
    this.noises = new NoiseSet(model.bundle, model.program.noises, seed, model.legacy);
    this.scratch = new Float64Array(model.program.nodes.length);
  }

  /** Quantised climate target at quart position, as Climate.Sampler.sample produces. */
  climate(qx: number, qy: number, qz: number): Float64Array {
    const v = evaluate(this.model.program, this.noises, qx * 4, qy * 4, qz * 4, this.scratch);
    const t = this.target;
    for (let i = 0; i < 6; i++) t[i] = quantize(v[this.model.roots[i]!]!);
    t[6] = 0;
    return t;
  }

  /**
   * Nearest parameter-list entry at quart position. `candidate` emulates the
   * game's per-thread last-result cache (pass the previous call's return value).
   */
  entry(qx: number, qy: number, qz: number, candidate = -1): number {
    return searchClimate(this.model.index!, this.climate(qx, qy, qz), candidate);
  }

  /** Biome index (into model.biomes) at quart position. */
  biome(qx: number, qy: number, qz: number): number {
    const idx = this.model.index;
    if (idx) return idx.entryBiome[this.entry(qx, qy, qz)]!;
    const erosionRoot = this.model.roots[3]!;
    const name = endBiome(qx, qz, (bx, bz) => evaluate(this.model.program, this.noises, bx, 0, bz, this.scratch)[erosionRoot]!);
    return this.model.biomes.indexOf(name);
  }
}

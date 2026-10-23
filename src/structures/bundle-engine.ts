import { qualify } from '../core/bundle';
import { BiomeGenerator, DimensionModel } from '../core/generator';
import { LegacyRandom } from '../core/rng';
import { frequencyPass, saltedRandom, weightedOrder } from './bundle-random';
import { integer, validateStructureBundle } from './bundle-validate';
import type {
  BundleCatalogResponse, BundleConcentricRingsPlacement, BundleDimension, BundlePlacement,
  BundlePlacementCandidate, BundlePosition, BundleRandomSpreadPlacement, BundleStructureRequest,
  BundleStructureResponse, BundleStructureResponseFor, BundleStructureSet, StructureBundle,
} from './bundle-schema';

const BLOCK_LIMIT = 30_000_000;
const MAX_SCAN = 16_384;
interface RingState {
  random: LegacyRandom; angle: number; ring: number; within: number; spread: number;
  positions: BundlePosition[]; preferred: Set<string>;
}

/** Synchronous CPU calculations; create and execute in a dedicated worker. */
export class BundleStructureEngine {
  readonly version = '26.2' as const;
  readonly preset: string;
  private bundle: StructureBundle | undefined;
  private generator: BiomeGenerator | undefined;
  private readonly possible: Set<string>;
  private readonly active = new Set<string>();
  private readonly activeSets = new Set<string>();
  private readonly ringStates = new Map<string, RingState>();

  private constructor(bundle: StructureBundle, private readonly seed: bigint, readonly dimension: BundleDimension, preset: string) {
    this.bundle = bundle;
    this.preset = preset;
    const modelKey = bundle.presets[preset]?.[dimension];
    if (!modelKey) throw new RangeError(`Bundle does not support ${dimension} in preset ${preset}`);
    const model = DimensionModel.fromBundle(bundle.biomes, modelKey);
    this.generator = new BiomeGenerator(model, seed);
    this.possible = new Set(model.biomes);
    for (const structure of Object.values(bundle.structures)) {
      if (structure.allowedBiomes.some(biome => this.possible.has(biome))) this.active.add(structure.id);
    }
    for (const set of Object.values(bundle.sets)) {
      if (set.structures.some(entry => this.active.has(entry.structure))) this.activeSets.add(set.id);
    }
  }

  static async create(input: unknown, seed: bigint, dimension: BundleDimension = 'overworld', preset = 'normal'): Promise<BundleStructureEngine> {
    if (typeof seed !== 'bigint' || seed < -(1n << 63n) || seed >= (1n << 63n)) throw new RangeError('seed must be a signed 64-bit bigint');
    if (!['overworld', 'nether', 'end'].includes(dimension)) throw new TypeError('Unknown structure dimension');
    if (typeof preset !== 'string') throw new TypeError('preset must be a registry ID');
    // Own the model data: callers cannot mutate a compiled engine through their input.
    const bundle = structuredClone(validateStructureBundle(input));
    return new BundleStructureEngine(bundle, seed, dimension, qualify(preset));
  }

  execute<R extends BundleStructureRequest>(request: R): BundleStructureResponseFor<R> {
    const bundle = this.requireBundle();
    if (!request || typeof request !== 'object') throw new TypeError('Expected a bundle structure request');
    let response: BundleStructureResponse;
    switch (request.op) {
      case 'catalog': response = this.catalog(); break;
      case 'position': {
        const set = this.randomSpreadSet(request.set);
        const x = this.region(request.regionX, 'regionX', set.placement);
        const z = this.region(request.regionZ, 'regionZ', set.placement);
        response = { op: 'position', set: set.id, candidate: this.candidate(set, x, z) }; break;
      }
      case 'scan': {
        const set = this.randomSpreadSet(request.set);
        const width = integer(request.width, 'width', 1, MAX_SCAN), height = integer(request.height, 'height', 1, MAX_SCAN);
        if (width * height > MAX_SCAN) throw new RangeError(`scan area must not exceed ${MAX_SCAN} regions`);
        const x = this.region(request.regionX, 'regionX', set.placement, width);
        const z = this.region(request.regionZ, 'regionZ', set.placement, height);
        const candidates: BundlePlacementCandidate[] = [];
        for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) candidates.push(this.candidate(set, x + dx, z + dz));
        response = { op: 'scan', set: set.id, regionX: x, regionZ: z, width, height, candidates }; break;
      }
      case 'rings': {
        const set = this.set(request.set ?? 'minecraft:strongholds');
        if (set.placement.type !== 'concentric_rings') throw new TypeError(`${set.id} is not a concentric-rings set`);
        const dimensionPass = this.setActive(set);
        const total = dimensionPass ? set.placement.count : 0;
        const offset = request.offset === undefined ? 0 : integer(request.offset, 'offset', 0, total);
        const count = request.count === undefined ? total - offset : integer(request.count, 'count', 0, total - offset);
        const positions = count ? this.rings(set, offset + count).slice(offset, offset + count).map(position => ({ ...position })) : [];
        response = { op: 'rings', set: set.id, total, offset, positions, adjustment: 'preferred-biome', dimensionPass }; break;
      }
      case 'biome': {
        if (typeof request.structure !== 'string') throw new TypeError('structure must be a registry ID');
        const id = qualify(request.structure), structure = bundle.structures[id];
        if (!structure) throw new RangeError(`Unknown structure ${id}`);
        const qx = integer(request.qx, 'qx', -7_500_000, 7_500_000);
        const qy = integer(request.qy, 'qy', -512, 512);
        const qz = integer(request.qz, 'qz', -7_500_000, 7_500_000);
        const generator = this.generator!;
        const biome = generator.model.biomes[generator.biome(qx, qy, qz)]!;
        response = { op: 'biome', structure: id, qx, qy, qz, biome, eligible: structure.allowedBiomes.includes(biome), dimensionPass: this.active.has(id), scope: 'explicit-quart-point-not-generation-start' }; break;
      }
      default: throw new TypeError('Unknown bundle structure operation');
    }
    return response as BundleStructureResponseFor<R>;
  }

  destroy(): void {
    this.bundle = undefined;
    this.generator = undefined;
    this.active.clear();
    this.activeSets.clear();
    this.possible.clear();
    this.ringStates.clear();
  }
  private requireBundle(): StructureBundle {
    if (!this.bundle) throw new Error('Bundle structure engine has been destroyed');
    return this.bundle;
  }
  private set(id: string): BundleStructureSet {
    if (typeof id !== 'string') throw new TypeError('set must be a registry ID');
    const set = this.requireBundle().sets[qualify(id)];
    if (!set) throw new RangeError(`Unknown structure set ${id}`);
    return set;
  }
  private randomSpreadSet(id: string): BundleStructureSet & { placement: BundleRandomSpreadPlacement } {
    const set = this.set(id);
    if (set.placement.type !== 'random_spread') throw new TypeError(`${set.id} uses concentric rings; use the rings operation`);
    return set as BundleStructureSet & { placement: BundleRandomSpreadPlacement };
  }
  private setActive(set: BundleStructureSet): boolean { return this.activeSets.has(set.id); }
  private region(value: unknown, name: string, placement: BundleRandomSpreadPlacement, extent = 1): number {
    const region = integer(value, name, -BLOCK_LIMIT, BLOCK_LIMIT);
    const span = placement.spacing * 16;
    if (region * span < -BLOCK_LIMIT || (region + extent) * span - 1 > BLOCK_LIMIT) throw new RangeError(`${name} region bounds exceed the supported block-coordinate range`);
    return region;
  }
  private position(placement: BundlePlacement, chunkX: number, chunkZ: number): BundlePosition {
    const blockX = chunkX * 16, blockZ = chunkZ * 16;
    return { chunkX, chunkZ, blockX, blockZ, locateX: blockX + placement.locateOffset[0], locateY: placement.locateOffset[1], locateZ: blockZ + placement.locateOffset[2] };
  }
  private potential(p: BundleRandomSpreadPlacement, regionX: number, regionZ: number): BundlePosition {
    const random = saltedRandom(this.seed, regionX, regionZ, p.salt);
    const bound = p.spacing - p.separation;
    let x = random.nextInt(bound);
    let z: number;
    if (p.spreadType === 'triangular') {
      x = Math.trunc((x + random.nextInt(bound)) / 2);
      z = Math.trunc((random.nextInt(bound) + random.nextInt(bound)) / 2);
    } else z = random.nextInt(bound);
    return this.position(p, regionX * p.spacing + x, regionZ * p.spacing + z);
  }
  private candidate(set: BundleStructureSet & { placement: BundleRandomSpreadPlacement }, regionX: number, regionZ: number): BundlePlacementCandidate {
    const position = this.potential(set.placement, regionX, regionZ);
    const dimensionPass = this.setActive(set);
    const frequency = frequencyPass(this.seed, position.chunkX, position.chunkZ, set.placement);
    const exclusion = frequency && dimensionPass ? !this.excluded(set, position.chunkX, position.chunkZ) : null;
    const placementPass = dimensionPass && frequency && exclusion === true;
    return { ...position, regionX, regionZ, initialCandidatePass: true, frequencyPass: frequency, exclusionPass: exclusion, dimensionPass, placementPass,
      attemptOrder: placementPass ? weightedOrder(this.seed, position.chunkX, position.chunkZ, set.structures) : [] };
  }
  private placementPass(set: BundleStructureSet, x: number, z: number): boolean {
    if (!this.setActive(set)) return false;
    const p = set.placement;
    if (p.type === 'random_spread') {
      const candidate = this.potential(p, Math.floor(x / p.spacing), Math.floor(z / p.spacing));
      if (candidate.chunkX !== x || candidate.chunkZ !== z) return false;
    } else if (!this.rings(set, p.count).some(position => position.chunkX === x && position.chunkZ === z)) return false;
    return frequencyPass(this.seed, x, z, p) && !this.excluded(set, x, z);
  }
  private excluded(set: BundleStructureSet, x: number, z: number): boolean {
    const zone = set.placement.exclusionZone;
    if (!zone) return false;
    const other = this.set(zone.otherSet);
    if (!this.setActive(other)) return false;
    const radius = zone.chunkCount, p = other.placement;
    // Only a random-spread region's single potential chunk can pass. Enumerating
    // intersecting regions is equivalent to testing every chunk of the square.
    if (p.type === 'random_spread') {
      for (let rz = Math.floor((z - radius) / p.spacing); rz <= Math.floor((z + radius) / p.spacing); rz++) {
        for (let rx = Math.floor((x - radius) / p.spacing); rx <= Math.floor((x + radius) / p.spacing); rx++) {
          const position = this.potential(p, rx, rz);
          if (Math.abs(position.chunkX - x) <= radius && Math.abs(position.chunkZ - z) <= radius && this.placementPass(other, position.chunkX, position.chunkZ)) return true;
        }
      }
    } else {
      for (const position of this.rings(other, p.count)) {
        if (Math.abs(position.chunkX - x) <= radius && Math.abs(position.chunkZ - z) <= radius && this.placementPass(other, position.chunkX, position.chunkZ)) return true;
      }
    }
    return false;
  }
  private rings(set: BundleStructureSet, count: number): BundlePosition[] {
    const p = set.placement as BundleConcentricRingsPlacement;
    let state = this.ringStates.get(set.id);
    if (!state) {
      const random = new LegacyRandom(this.seed);
      state = { random, angle: random.nextDouble() * Math.PI * 2, ring: 0, within: 0, spread: p.spread, positions: [], preferred: new Set(p.preferredBiomes) };
      this.ringStates.set(set.id, state);
    }
    const generator = this.generator!, model = generator.model;
    while (state.positions.length < count) {
      const index = state.positions.length;
      const distance = 4 * p.distance + p.distance * state.ring * 6 + (state.random.nextDouble() - 0.5) * p.distance * 2.5;
      let x = Math.floor(Math.cos(state.angle) * distance + 0.5), z = Math.floor(Math.sin(state.angle) * distance + 0.5);
      const random = new LegacyRandom(state.random.nextLong());
      const centerX = x * 4 + 2, centerZ = z * 4 + 2;
      let matches = 0, entry = -1;
      for (let qz = centerZ - 28; qz <= centerZ + 28; qz++) {
        for (let qx = centerX - 28; qx <= centerX + 28; qx++) {
          let biome: string;
          if (model.index) {
            entry = generator.entry(qx, 0, qz, entry);
            biome = model.biomes[model.index.entryBiome[entry]!]!;
          } else biome = model.biomes[generator.biome(qx, 0, qz)]!;
          if (state.preferred.has(biome) && (++matches === 1 || random.nextInt(matches) === 0)) {
            x = Math.floor(qx / 4); z = Math.floor(qz / 4);
          }
        }
      }
      state.positions.push(this.position(p, x, z));
      state.angle += 2 * Math.PI / state.spread;
      state.within++;
      if (state.within === state.spread) {
        state.ring++; state.within = 0;
        state.spread += Math.trunc(2 * state.spread / (state.ring + 1));
        state.spread = Math.min(state.spread, p.count - index);
        state.angle += state.random.nextDouble() * Math.PI * 2;
      }
    }
    return state.positions;
  }
  private catalog(): BundleCatalogResponse {
    const bundle = this.requireBundle();
    return {
      op: 'catalog', version: this.version, dimension: this.dimension, preset: this.preset,
      capabilities: { randomSpread: true, frequency: true, exclusion: true, weightedAttemptOrder: true, pointBiomeEligibility: true, concentricRings: 'preferred-biome-adjusted', generationStarts: false, terrain: false, pieces: false },
      sets: Object.values(bundle.sets).map(set => ({ ...structuredClone(set), activeStructures: set.structures.filter(entry => this.active.has(entry.structure)).map(entry => ({ ...entry })) })),
      structures: Object.values(bundle.structures).map(structure => ({ ...structuredClone(structure), active: this.active.has(structure.id) })),
    };
  }
}

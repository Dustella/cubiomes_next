import { LegacyCpu } from './legacy/cpu';
import { LegacyGpu } from './legacy/gpu';
import { ModernCpu, ModernGpu } from './modern';
import { StandardDimensionCpu } from './dimensions/cpu';
import { StandardDimensionGpu } from './dimensions/gpu';
import { validatePosition, validateRegion, validateSeed } from './inputs';
import { resolveVersion, type Dimension, type MinecraftVersion } from './versions';
import type { GpuResult, Region } from './gpu/runner';

export interface BiomeOptions {
  /** Exact supported release or major alias; major 1.21 resolves to 1.21.3. */
  version: string;
  dimension: Dimension;
  seed: bigint;
  /** Overworld only; introduced in 1.3. */
  largeBiomes?: boolean;
}

interface CpuBackend {
  biome(qx: number, qy: number, qz: number): number;
  run(region: Region): Uint32Array;
}
interface GpuBackend {
  setSeed(seed: bigint): void;
  run(region: Region): Promise<GpuResult>;
  destroy(): void;
}

function settings(options: BiomeOptions): MinecraftVersion {
  const version = resolveVersion(options.version);
  if (!['overworld', 'nether', 'end'].includes(options.dimension)) throw new RangeError('Unknown dimension');
  validateSeed(options.seed);
  if (options.largeBiomes !== undefined && typeof options.largeBiomes !== 'boolean') throw new TypeError('largeBiomes must be boolean');
  if (options.largeBiomes && (options.dimension !== 'overworld' || version.mc < 6)) {
    throw new RangeError('Large Biomes requires Overworld version 1.3 or later');
  }
  return version;
}

/** Cubiomes numeric biome IDs, quart coordinates, row-major rectangular output.
 * No server jars, bundles, native modules, or WebGPU device are required.
 */
export class CpuBiomeGenerator {
  readonly version: MinecraftVersion;
  readonly dimension: Dimension;
  readonly seed: bigint;
  readonly largeBiomes: boolean;
  private readonly backend: CpuBackend;

  constructor(options: BiomeOptions) {
    this.version = settings(options);
    this.dimension = options.dimension;
    this.seed = options.seed;
    this.largeBiomes = options.largeBiomes ?? false;
    const mc = this.version.mc;
    this.backend = this.dimension !== 'overworld'
      ? new StandardDimensionCpu(mc, this.dimension, this.seed)
      : mc <= 21 ? new LegacyCpu(mc, this.seed, this.largeBiomes) : new ModernCpu(mc, this.seed, this.largeBiomes);
  }

  biome(qx: number, qy: number, qz: number): number {
    validatePosition(qx, qy, qz);
    return this.backend.biome(qx, qy, qz);
  }

  run(region: Region): Uint32Array {
    validateRegion(region);
    return this.backend.run(region);
  }
}

/** Actual WebGPU computation. Owns backend buffers/pipelines, not the device.
 * One in-flight operation per runner; use separate runners for concurrency.
 * Call destroy() after awaited runs. Changing seeds does not recompile shaders.
 */
export class GpuVersionBiomeRunner {
  private busy = false;
  private destroyed = false;
  private currentSeed: bigint;

  private constructor(
    readonly device: GPUDevice,
    readonly version: MinecraftVersion,
    readonly dimension: Dimension,
    readonly largeBiomes: boolean,
    private readonly backend: GpuBackend,
    seed: bigint,
  ) {
    this.currentSeed = seed;
  }

  static async create(device: GPUDevice, options: BiomeOptions): Promise<GpuVersionBiomeRunner> {
    const version = settings(options);
    const large = options.largeBiomes ?? false;
    const { dimension, seed } = options;
    const backend: GpuBackend = dimension !== 'overworld'
      ? await StandardDimensionGpu.create(device, version.mc, dimension)
      : version.mc <= 21 ? await LegacyGpu.create(device, version.mc, large) : await ModernGpu.create(device, version.mc, large);
    try {
      backend.setSeed(seed);
    } catch (error) {
      backend.destroy();
      throw error;
    }
    return new GpuVersionBiomeRunner(device, version, dimension, large, backend, seed);
  }

  get seed(): bigint { return this.currentSeed; }

  private assertIdle(): void {
    if (this.destroyed) throw new Error('Biome runner is destroyed');
    if (this.busy) throw new Error('Biome runner has an in-flight run; await it before reuse');
  }

  setSeed(seed: bigint): void {
    this.assertIdle();
    validateSeed(seed);
    this.backend.setSeed(seed);
    this.currentSeed = seed;
  }

  async run(region: Region): Promise<GpuResult> {
    this.assertIdle();
    validateRegion(region);
    const bytes = region.w * region.h * 4;
    if (bytes > this.device.limits.maxStorageBufferBindingSize || bytes > this.device.limits.maxBufferSize) {
      throw new RangeError('Region output exceeds WebGPU device buffer limits');
    }
    if (Math.ceil(region.w * region.h / 64) > this.device.limits.maxComputeWorkgroupsPerDimension) {
      throw new RangeError('Region output exceeds WebGPU dispatch limits');
    }
    // Capture scalar inputs before asynchronous work, so callers may reuse them.
    const snapshot = { ...region };
    this.busy = true;
    try {
      return await this.backend.run(snapshot);
    } finally {
      this.busy = false;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.assertIdle();
    this.backend.destroy();
    this.destroyed = true;
  }
}

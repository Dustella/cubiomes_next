import { validateSeed } from '../inputs';
import type { BundleDimension, BundleStructureRequest, BundleStructureResponseFor, StructureBundle } from './bundle-schema';
import { WorkerChannel } from './worker-channel';

export interface BundleStructureWorldOptions {
  seed: bigint;
  dimension?: BundleDimension;
  /** World preset ID, default normal. */
  preset?: string;
}
export interface BundleStructureRuntimeOptions {
  /** Locally built data bundle, or a URL loaded/parsed only inside the worker. */
  bundle: string | URL | StructureBundle;
  workerURL?: string | URL;
}

/** Data-driven structure-set calculations, separate from the Cubiomes numeric
 * API. Capabilities describe candidate placement and explicit biome eligibility,
 * not complete terrain-dependent structure starts or recursive piece layouts.
 */
export class BundleStructureWorker {
  private constructor(
    private readonly channel: WorkerChannel,
    readonly version: string,
    readonly seed: bigint,
    readonly dimension: BundleDimension,
    readonly preset: string,
  ) {}

  static async create(world: BundleStructureWorldOptions, runtime: BundleStructureRuntimeOptions): Promise<BundleStructureWorker> {
    validateSeed(world.seed);
    const seed = world.seed;
    const dimension = world.dimension ?? 'overworld';
    if (dimension !== 'overworld' && dimension !== 'nether' && dimension !== 'end') throw new RangeError('Unknown structure dimension');
    const preset = world.preset ?? 'normal';
    if (typeof preset !== 'string' || !preset) throw new TypeError('preset must be a nonempty string');
    if (!runtime || runtime.bundle === undefined) throw new TypeError('A structure data bundle is required');
    const base = typeof location === 'undefined' ? import.meta.url : location.href;
    const workerURL = new URL(runtime.workerURL ?? '/structure-worker.js', base);
    const bundle = typeof runtime.bundle === 'string' || runtime.bundle instanceof URL
      ? new URL(runtime.bundle, base).href : runtime.bundle;
    const channel = new WorkerChannel(workerURL, `bundle-structures-${dimension}`);
    try {
      const reply = await channel.send({ kind: 'initializeBundle', world: { seed, dimension, preset }, bundle });
      if (!reply.ok || reply.kind !== 'bundleInitialized') throw new Error('Unexpected bundle worker initialization reply');
      return new BundleStructureWorker(channel, reply.version, seed, dimension, preset);
    } catch (error) {
      channel.terminate();
      throw error;
    }
  }

  async execute<R extends BundleStructureRequest>(request: R): Promise<BundleStructureResponseFor<R>> {
    const reply = await this.channel.send({ kind: 'executeBundle', request });
    if (!reply.ok || reply.kind !== 'bundleResult') throw new Error('Unexpected bundle worker query reply');
    return reply.result as BundleStructureResponseFor<R>;
  }

  terminate(): void {
    this.channel.terminate();
  }
}

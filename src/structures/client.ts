import { validateSeed } from '../inputs';
import { resolveStructureVersion } from './catalog';
import type { MinecraftVersion } from '../versions';
import type { StructureRequest, StructureResponseFor } from './types';
import { WorkerChannel } from './worker-channel';

export interface StructureWorldOptions {
  version: string;
  seed: bigint;
  largeBiomes?: boolean;
}
export interface StructureRuntimeOptions {
  /** Deploy the built public/structure-worker.js asset here. */
  workerURL?: string | URL;
  /** Defaults to structures.wasm beside workerURL. Bytes are copied before
   * transfer, so caller-owned buffers are never detached. Default fetching,
   * compilation and all calculations happen in the worker. */
  wasm?: string | URL | ArrayBuffer | Uint8Array | WebAssembly.Module;
}

/** One world and one private WASM instance per dedicated worker. Requests are
 * processed serially off-thread; callers may enqueue concurrent promises.
 * terminate() rejects pending requests and releases the worker and WASM memory.
 */
export class StructureWorker {

  private constructor(
    private readonly channel: WorkerChannel,
    readonly version: MinecraftVersion,
    readonly seed: bigint,
    readonly largeBiomes: boolean,
  ) {}

  static async create(world: StructureWorldOptions, runtime: StructureRuntimeOptions = {}): Promise<StructureWorker> {
    const version = resolveStructureVersion(world.version);
    validateSeed(world.seed);
    const seed = world.seed;
    const large = world.largeBiomes ?? false;
    if (typeof large !== 'boolean') throw new TypeError('largeBiomes must be boolean');
    if (large && version.mc < 6) throw new RangeError('Large Biomes requires version 1.3 or later');
    const base = typeof location === 'undefined' ? import.meta.url : location.href;
    const workerURL = new URL(runtime.workerURL ?? '/structure-worker.js', base);
    let wasm: string | ArrayBuffer | WebAssembly.Module;
    const transfer: Transferable[] = [];
    if (runtime.wasm instanceof ArrayBuffer) {
      wasm = runtime.wasm.slice(0);
      transfer.push(wasm);
    } else if (runtime.wasm instanceof Uint8Array) {
      wasm = new Uint8Array(runtime.wasm).buffer;
      transfer.push(wasm);
    } else if (runtime.wasm instanceof WebAssembly.Module) {
      wasm = runtime.wasm;
    } else {
      wasm = new URL(runtime.wasm ?? 'structures.wasm', workerURL).href;
    }
    const channel = new WorkerChannel(workerURL, `cubiomes-structures-${version.id}`);
    try {
      const reply = await channel.send({ kind: 'initialize', world: { mc: version.mc, seed, largeBiomes: large }, wasm }, transfer);
      if (!reply.ok || reply.kind !== 'initialized') throw new Error('Unexpected structure worker initialization reply');
      return new StructureWorker(channel, version, seed, large);
    } catch (error) {
      channel.terminate();
      throw error;
    }
  }

  async execute<R extends StructureRequest>(request: R): Promise<StructureResponseFor<R>> {
    const reply = await this.channel.send({ kind: 'execute', request });
    if (!reply.ok || reply.kind !== 'result') throw new Error('Unexpected structure worker query reply');
    return reply.result as StructureResponseFor<R>;
  }

  terminate(): void {
    this.channel.terminate();
  }
}

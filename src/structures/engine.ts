import type { StructureConfig, StructureRequest, StructureResponse, StructureResponseFor } from './types';

type Bridge = {
  memory: WebAssembly.Memory;
  sb_abi(): number;
  sb_set_world(mc: number, low: number, high: number, large: number): number;
  sb_run(op: number, type: number, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number): number;
  sb_result_ptr(): number;
  sb_result_len(): number;
  sb_error_ptr(): number;
  sb_destroy(): void;
  _initialize?: () => void;
};
const BLOCK_LIMIT = 30_000_000;
const MAX_SCAN = 16_384;
const MAX_PIECES = 16_384;
const decoder = new TextDecoder('utf-8', { fatal: true });

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}
function optionalInteger(value: unknown, fallback: number, name: string, min: number, max: number): number {
  return value === undefined ? fallback : integer(value, name, min, max);
}
function optionalBoolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

/** Low-level synchronous engine. Use StructureWorker on the browser's main thread. */
export class StructureEngine {
  private bridge: Bridge | undefined;
  private mc: number | undefined;
  private configs: StructureConfig[] = [];

  private constructor(bridge: Bridge) { this.bridge = bridge; }

  static async create(input: WebAssembly.Module | BufferSource): Promise<StructureEngine> {
    const module = input instanceof WebAssembly.Module ? input : await WebAssembly.compile(input);
    let bridge: Bridge | undefined;
    const view = () => {
      if (!bridge) throw new Error('WASI accessed memory before reactor instantiation');
      return new DataView(bridge.memory.buffer);
    };
    // Filesystem-free WASI reactor support. Cubiomes math runs in the actual
    // WASI libc/libm, never JS approximations or imported noise stubs. The libc
    // imports a clock even though structure algorithms do not depend on it.
    const wasi: Record<string, (...args: number[]) => number | void> = {
      clock_time_get: (clockId, _precision, pointer) => {
        let nanoseconds: bigint;
        if (clockId === 0) nanoseconds = BigInt(Date.now()) * 1_000_000n;
        else if (clockId === 1) {
          if (typeof performance === 'undefined') return 58; // ENOTSUP
          nanoseconds = BigInt(Math.floor(performance.now() * 1_000_000));
        } else return 28; // EINVAL: process/thread CPU clocks are unavailable.
        view().setBigUint64(pointer, nanoseconds, true);
        return 0;
      },
      fd_write: (_fd, iovs, count, written) => {
        const data = view();
        let length = 0;
        for (let i = 0; i < count; i++) length += data.getUint32(iovs + i * 8 + 4, true);
        data.setUint32(written, length, true);
        return 0;
      },
      fd_close: () => 0,
      fd_seek: () => 70, // ESPIPE: no seekable descriptors exist.
      fd_fdstat_get: (fd, pointer) => {
        if (fd < 0 || fd > 2) return 8; // EBADF
        const data = view();
        for (let i = 0; i < 24; i++) data.setUint8(pointer + i, 0);
        data.setUint8(pointer, 2); // character device
        return 0;
      },
      environ_sizes_get: (count, bytes) => { const data = view(); data.setUint32(count, 0, true); data.setUint32(bytes, 0, true); return 0; },
      environ_get: () => 0,
      args_sizes_get: (count, bytes) => { const data = view(); data.setUint32(count, 0, true); data.setUint32(bytes, 0, true); return 0; },
      args_get: () => 0,
      proc_exit: code => { throw new WebAssembly.RuntimeError(`Structure WASM exited with status ${code}`); },
    };
    for (const entry of WebAssembly.Module.imports(module)) {
      if (entry.kind !== 'function' || entry.module !== 'wasi_snapshot_preview1' || !(entry.name in wasi)) {
        throw new TypeError(`Unsupported structure WASM import ${entry.module}.${entry.name}`);
      }
    }
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
    const exports = instance.exports;
    if (!(exports.memory instanceof WebAssembly.Memory)) throw new TypeError('Structure WASM must export memory');
    for (const name of ['sb_abi', 'sb_set_world', 'sb_run', 'sb_result_ptr', 'sb_result_len', 'sb_error_ptr', 'sb_destroy']) {
      if (typeof exports[name] !== 'function') throw new TypeError(`Structure WASM is missing ${name}`);
    }
    bridge = exports as unknown as Bridge;
    bridge._initialize?.();
    if (bridge.sb_abi() !== 1) throw new TypeError('Unsupported structure WASM ABI');
    return new StructureEngine(bridge);
  }

  setWorld(mc: number, seed: bigint, largeBiomes: boolean): void {
    const bridge = this.requireBridge();
    integer(mc, 'mc', 3, 28);
    if (typeof seed !== 'bigint' || seed < -(1n << 63n) || seed >= (1n << 63n)) throw new RangeError('seed must be a signed 64-bit bigint');
    if (typeof largeBiomes !== 'boolean') throw new TypeError('largeBiomes must be a boolean');
    if (largeBiomes && mc < 6) throw new RangeError('Large biomes require Minecraft 1.3 or newer');
    const bits = BigInt.asUintN(64, seed);
    if (bridge.sb_set_world(mc, Number(bits & 0xffff_ffffn), Number(bits >> 32n), largeBiomes ? 1 : 0)) throw this.bridgeError();
    this.mc = mc;
    const catalog = this.run(0) as StructureResponseFor<{ op: 'catalog' }>;
    this.configs = catalog.structures;
  }

  execute<R extends StructureRequest>(request: R): StructureResponseFor<R> {
    this.requireBridge();
    if (this.mc === undefined) throw new Error('Structure world is not initialized');
    if (!request || typeof request !== 'object' || typeof request.op !== 'string') throw new TypeError('Expected a structure request');
    let result: StructureResponse;
    const type = () => integer('type' in request ? request.type : undefined, 'type', 0, 24);
    const block = (value: unknown, name: string) => integer(value, name, -BLOCK_LIMIT, BLOCK_LIMIT);
    const chunk = (value: unknown, name: string) => integer(value, name, -1_874_999, 1_874_999);
    const region = (value: unknown, name: string, id: number, extent = 1) => {
      const coordinate = integer(value, name, -BLOCK_LIMIT, BLOCK_LIMIT);
      const config = this.configs[id]!;
      if (config.supported) {
        const span = config.regionSize! * 16;
        if (coordinate * span < -BLOCK_LIMIT || (coordinate + extent) * span - 1 > BLOCK_LIMIT) {
          throw new RangeError(`${name} region bounds exceed the supported block-coordinate range`);
        }
      }
      return coordinate;
    };
    switch (request.op) {
      case 'catalog': result = this.run(0); break;
      case 'position': {
        const id = type();
        result = this.run(1, id, region(request.regionX, 'regionX', id), region(request.regionZ, 'regionZ', id)); break;
      }
      case 'scan': {
        const id = type();
        const width = integer(request.width, 'width', 1, MAX_SCAN);
        const height = integer(request.height, 'height', 1, MAX_SCAN);
        if (width * height > MAX_SCAN) throw new RangeError(`scan area must not exceed ${MAX_SCAN} regions`);
        const stage = request.stage === undefined ? 'placement' : request.stage;
        if (stage !== 'placement' && stage !== 'biome' && stage !== 'terrain') throw new TypeError('Unknown structure scan stage');
        result = this.run(2, id, region(request.regionX, 'regionX', id, width), region(request.regionZ, 'regionZ', id, height), width, height,
          stage === 'placement' ? 0 : stage === 'biome' ? 1 : 2, +optionalBoolean(request.includeRejected, 'includeRejected'),
          optionalInteger(request.flags, 0, 'flags', 0, 0xffff_ffff)); break;
      }
      case 'check': result = this.run(3, type(), block(request.x, 'x'), block(request.z, 'z'), optionalInteger(request.flags, 0, 'flags', 0, 0xffff_ffff), +optionalBoolean(request.terrain, 'terrain')); break;
      case 'featureBiome': result = this.run(4, type(), integer(request.biome, 'biome', 0, 255)); break;
      case 'variant': {
        const id = type();
        if (this.configs[id]!.variantRequiresBiome && request.biome === undefined) throw new TypeError('This structure variant requires an explicit biome');
        const biome = optionalInteger(request.biome, -1, 'biome', -1, 255);
        if (this.configs[id]!.variantRequiresBiome && biome < 0) throw new RangeError('This structure variant requires a nonnegative biome');
        result = this.run(5, id, block(request.x, 'x'), block(request.z, 'z'), biome); break;
      }
      case 'strongholds': {
        const total = this.mc >= 12 ? 128 : 3;
        const offset = optionalInteger(request.offset, 0, 'offset', 0, total);
        const count = optionalInteger(request.count, total - offset, 'count', 0, total - offset);
        result = this.run(6, 0, offset, count); break;
      }
      case 'pieces': {
        const id = type();
        if (id !== 18 && id !== 20) throw new RangeError('pieces supports only Fortress (18) and End City (20)');
        result = this.run(7, id, chunk(request.chunkX, 'chunkX'), chunk(request.chunkZ, 'chunkZ'), optionalInteger(request.maxPieces, 4096, 'maxPieces', 1, MAX_PIECES)); break;
      }
      case 'endIslands': result = this.run(8, 0, chunk(request.chunkX, 'chunkX'), chunk(request.chunkZ, 'chunkZ')); break;
      case 'fixedGateways': result = this.run(9); break;
      case 'linkedGateway': {
        const x = integer(request.x, 'x', -46_340, 46_340), z = integer(request.z, 'z', -46_340, 46_340);
        if ((x === 0 && z === 0) || x * x + z * z > 0x7fff_ffff) throw new RangeError('Gateway source must be nonzero with squared radius at most INT32_MAX');
        result = this.run(10, 0, x, z); break;
      }
      case 'villageHouses': result = this.run(11, 0, chunk(request.chunkX, 'chunkX'), chunk(request.chunkZ, 'chunkZ')); break;
      case 'endChunkEmpty': result = this.run(12, 0, chunk(request.chunkX, 'chunkX'), chunk(request.chunkZ, 'chunkZ')); break;
      default: throw new TypeError('Unknown structure operation');
    }
    return result as StructureResponseFor<R>;
  }

  destroy(): void {
    if (!this.bridge) return;
    this.bridge.sb_destroy();
    this.bridge = undefined;
    this.configs = [];
    this.mc = undefined;
  }

  private requireBridge(): Bridge {
    if (!this.bridge) throw new Error('Structure engine has been destroyed');
    return this.bridge;
  }
  private bridgeError(status = -1): Error {
    const bridge = this.requireBridge();
    const bytes = new Uint8Array(bridge.memory.buffer);
    const start = bridge.sb_error_ptr() >>> 0;
    let end = start;
    while (end < bytes.length && bytes[end] !== 0 && end - start < 4096) end++;
    const message = decoder.decode(bytes.subarray(start, end)) || 'Structure WASM operation failed';
    return status === -2 ? new RangeError(message) : new Error(message);
  }
  private run(op: number, type = 0, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0): StructureResponse {
    const bridge = this.requireBridge();
    const status = bridge.sb_run(op, type, a, b, c, d, e, f, g, h);
    if (status) throw this.bridgeError(status);
    const start = bridge.sb_result_ptr() >>> 0, length = bridge.sb_result_len() >>> 0;
    if (length === 0 || length > 16 * 1024 * 1024 || start + length > bridge.memory.buffer.byteLength) throw new Error('Invalid structure WASM result bounds');
    return JSON.parse(decoder.decode(new Uint8Array(bridge.memory.buffer, start, length))) as StructureResponse;
  }
}

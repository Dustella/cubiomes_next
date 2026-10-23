// Actual WebGPU standard-dimension biome computation. CPU work is limited to
// seed-derived permutations/offsets; no CPU biome map is uploaded.
import type { GpuResult, Region } from '../gpu/runner';
import { StandardDimensionCpu, validateStandardDimension, type StandardDimension } from './cpu';
import { standardDimensionShader } from './shader';

function storage(device: GPUDevice, data: Uint32Array | Float32Array): GPUBuffer {
  const buffer = device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  if (data.byteLength) device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
  return buffer;
}

function packPerm(perm: Uint8Array, output: Uint32Array, start = 0): void {
  for (let i = 0; i < 64; i++) {
    output[start + i] = (perm[i * 4]! | (perm[i * 4 + 1]! << 8) | (perm[i * 4 + 2]! << 16) | (perm[i * 4 + 3]! << 24)) >>> 0;
  }
}

export class StandardDimensionGpu {
  readonly wgsl: string;
  private seed: bigint | null = null;
  private octaves: GPUBuffer | null = null;
  private endPerm: GPUBuffer | null = null;
  private offsets: GPUBuffer | null = null;
  private destroyed = false;

  private constructor(
    readonly device: GPUDevice,
    readonly version: number,
    readonly dimension: StandardDimension,
    wgsl: string,
    private readonly pipeline: GPUComputePipeline,
    private readonly layout: GPUBindGroupLayout,
  ) { this.wgsl = wgsl; }

  static async create(device: GPUDevice, version: number, dimension: StandardDimension): Promise<StandardDimensionGpu> {
    validateStandardDimension(version, dimension);
    const wgsl = standardDimensionShader(version, dimension);
    const module = device.createShaderModule({ code: wgsl });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === 'error');
    if (errors.length) throw new Error(`Standard dimension WGSL compile failed:\n${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n')}`);
    const kinds: GPUBufferBindingType[] = ['uniform', 'read-only-storage', 'read-only-storage', 'read-only-storage', 'storage'];
    const layout = device.createBindGroupLayout({
      entries: kinds.map((type, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } })),
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint: 'main' },
    });
    return new StandardDimensionGpu(device, version, dimension, wgsl, pipeline, layout);
  }

  setSeed(seed: bigint): void {
    if (this.destroyed) throw new Error('Runner is destroyed');
    if (seed === this.seed) return;
    const cpu = new StandardDimensionCpu(this.version, this.dimension, seed);
    const octaves = [...(cpu.temperature?.octaves ?? []), ...(cpu.humidity?.octaves ?? [])];
    const words = new Uint32Array(Math.max(1, octaves.length) * 70);
    const offsets = new Float32Array(Math.max(1, octaves.length) * 6);
    octaves.forEach((octave, index) => {
      packPerm(octave.perm, words, index * 70);
      [octave.xo, octave.yo, octave.zo].forEach((value, axis) => {
        const at = index * 6 + axis * 2;
        offsets[at] = Math.fround(value);
        offsets[at + 1] = Math.fround(value - offsets[at]!);
      });
    });
    const end = new Uint32Array(64);
    if (cpu.end) packPerm(cpu.end.perm, end);
    const nextOctaves = storage(this.device, words);
    const nextEndPerm = storage(this.device, end);
    const nextOffsets = storage(this.device, offsets);
    this.octaves?.destroy(); this.endPerm?.destroy(); this.offsets?.destroy();
    this.octaves = nextOctaves; this.endPerm = nextEndPerm; this.offsets = nextOffsets;
    this.seed = seed;
  }

  async run(region: Region): Promise<GpuResult> {
    if (this.destroyed) throw new Error('Runner is destroyed');
    if (!this.octaves || !this.endPerm || !this.offsets) throw new Error('setSeed() first');
    const count = region.w * region.h;
    if (count === 0) return { biomes: new Uint32Array(), gpuMs: 0 };
    if (Math.ceil(count / 64) > this.device.limits.maxComputeWorkgroupsPerDimension) throw new RangeError('Region exceeds WebGPU dispatch limit');
    if (count * 4 > this.device.limits.maxStorageBufferBindingSize) throw new RangeError('Region exceeds WebGPU storage limit');
    const device = this.device;
    const params = new Int32Array([region.x0, region.z0, region.w, region.h, region.step, region.qy, 0, 0]);
    const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const output = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const start = performance.now();
    try {
      device.queue.writeBuffer(uniform, 0, params);
      const bind = device.createBindGroup({
        layout: this.layout,
        entries: [uniform, this.octaves, this.endPerm, this.offsets, output].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, count * 4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const biomes = new Uint32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      return { biomes, gpuMs: performance.now() - start };
    } finally {
      uniform.destroy(); output.destroy(); readback.destroy();
    }
  }

  destroy(): void {
    this.octaves?.destroy(); this.endPerm?.destroy(); this.offsets?.destroy();
    this.octaves = this.endPerm = this.offsets = null;
    this.seed = null;
    this.destroyed = true;
  }
}

// WebGPU execution of a generated biome shader. One pipeline per dimension
// model; seeds swap only the octave/end-perm buffers.

import type { DimensionModel } from '../core/generator';
import { NoiseSet } from '../core/evaluate';
import { buildGpuProgram, packEndPerm, packOctaves, WORKGROUP, type GpuProgram } from './codegen';

export interface Region {
  x0: number;
  z0: number;
  w: number;
  h: number;
  step: number;
  qy: number;
}

export interface GpuResult {
  biomes: Uint32Array;
  /** Present when requested: 6 quantised climate values per sample. */
  climate?: Int32Array;
  gpuMs: number;
}

function storage(device: GPUDevice, data: ArrayBufferView): GPUBuffer {
  const buf = device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
  return buf;
}

export class GpuBiomeRunner {
  readonly program: GpuProgram;
  private readonly pipeline: GPUComputePipeline;
  private readonly layout: GPUBindGroupLayout;
  private readonly tree: GPUBuffer;
  private readonly entryBiome: GPUBuffer;
  private octs: GPUBuffer | null = null;
  private endPerm: GPUBuffer | null = null;
  private seed: bigint | null = null;

  private constructor(readonly device: GPUDevice, readonly model: DimensionModel, program: GpuProgram, pipeline: GPUComputePipeline, layout: GPUBindGroupLayout) {
    this.program = program;
    this.pipeline = pipeline;
    this.layout = layout;
    this.tree = storage(device, program.tree);
    this.entryBiome = storage(device, program.entryBiome);
  }

  static async create(device: GPUDevice, model: DimensionModel): Promise<GpuBiomeRunner> {
    // Octave counts are seed independent, so any seed works for layout.
    const program = buildGpuProgram(model, new NoiseSet(model.bundle, model.program.noises, 0n, model.legacy));
    const module = device.createShaderModule({ code: program.wgsl });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) {
      throw new Error(`WGSL compile failed:\n${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n')}`);
    }
    // Explicit layout: 'auto' would drop bindings a given dimension never reads.
    const kinds: GPUBufferBindingType[] = ['uniform', 'read-only-storage', 'read-only-storage', 'read-only-storage', 'read-only-storage', 'storage', 'storage'];
    const layout = device.createBindGroupLayout({
      entries: kinds.map((type, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } })),
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: 'main' },
    });
    return new GpuBiomeRunner(device, model, program, pipeline, layout);
  }

  setSeed(seed: bigint): void {
    if (this.seed === seed) return;
    const noises = new NoiseSet(this.model.bundle, this.model.program.noises, seed, this.model.legacy);
    this.octs?.destroy();
    this.endPerm?.destroy();
    this.octs = storage(this.device, packOctaves(this.program, noises));
    this.endPerm = storage(this.device, packEndPerm(noises));
    this.seed = seed;
  }

  async run(r: Region, withClimate = false): Promise<GpuResult> {
    if (!this.octs || !this.endPerm) throw new Error('setSeed() first');
    const d = this.device;
    const n = r.w * r.h;
    const params = new Int32Array([r.x0, r.z0, r.w, r.h, r.step, r.qy, withClimate ? 1 : 0, 0]);
    let ubuf: GPUBuffer | null = null;
    let outB: GPUBuffer | null = null;
    let outC: GPUBuffer | null = null;
    let readB: GPUBuffer | null = null;
    let readC: GPUBuffer | null = null;
    try {
      ubuf = d.createBuffer({ size: params.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(ubuf, 0, params);
      outB = d.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      outC = d.createBuffer({ size: withClimate ? n * 24 : 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      readB = d.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      readC = withClimate ? d.createBuffer({ size: n * 24, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }) : null;
      d.pushErrorScope('validation');
      const bind = d.createBindGroup({
        layout: this.layout,
        entries: [ubuf, this.octs, this.tree, this.entryBiome, this.endPerm, outB, outC].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      const bindErr = await d.popErrorScope();
      if (bindErr) throw new Error(`WebGPU bind group: ${bindErr.message}`);
      const t0 = performance.now();
      d.pushErrorScope('validation');
      const enc = d.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(n / WORKGROUP));
      pass.end();
      enc.copyBufferToBuffer(outB, 0, readB, 0, n * 4);
      if (readC) enc.copyBufferToBuffer(outC, 0, readC, 0, n * 24);
      d.queue.submit([enc.finish()]);
      const err = await d.popErrorScope();
      if (err) throw new Error(`WebGPU validation: ${err.message}`);
      await readB.mapAsync(GPUMapMode.READ);
      const biomes = new Uint32Array(readB.getMappedRange().slice(0));
      readB.unmap();
      let climate: Int32Array | undefined;
      if (readC) {
        await readC.mapAsync(GPUMapMode.READ);
        climate = new Int32Array(readC.getMappedRange().slice(0));
        readC.unmap();
      }
      const gpuMs = performance.now() - t0;
      return { biomes, climate, gpuMs };
    } finally {
      for (const b of [ubuf, outB, outC, readB, readC]) b?.destroy();
    }
  }

  destroy(): void {
    this.octs?.destroy();
    this.endPerm?.destroy();
    this.tree.destroy();
    this.entryBiome.destroy();
    this.octs = null;
    this.endPerm = null;
    this.seed = null;
  }
}

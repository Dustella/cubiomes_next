import type { Region, GpuResult } from '../gpu/runner';
import { ImprovedNoise } from '../core/noise';
import { LegacyRandom } from '../core/rng';
import { makeStack, planStack, seedStack, type Layer, type Plan } from './stack';
import { LEGACY_SHADER_BASE } from './shader-base';
import { LEGACY_SHADER_RULES } from './shader-rules';

const ENTRY_POINTS = /* wgsl */ `
@group(0) @binding(4) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3<u32>){
  let l=layers[u32(params.node)]; let i=i32(gid.x);
  if(i>=l.w*l.h){return;}
  data[u32(l.offset+i)]=cell(l.op,l.x+i%l.w,l.z+i/l.w);
}
@compute @workgroup_size(64) fn gather(@builtin(global_invocation_id) gid:vec3<u32>){
  let i=i32(gid.x); if(i>=params.pad1*params.pad2){return;}
  let l=layers[u32(params.node)];
  output[gid.x]=u32(sample(params.node,l.x+(i%params.pad1)*params.pad0,l.z+(i/params.pad1)*params.pad0));
}
`;
function storage(device: GPUDevice, size: number, data?: ArrayBufferView): GPUBuffer {
  const buffer = device.createBuffer({ size: Math.max(16, size), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  if (data) device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
  return buffer;
}
function packLayers(layers: Layer[], plan: Plan, mc: number): Int32Array {
  const words = new Int32Array(layers.length * 16);
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i]!, a = plan.areas[i];
    if (!a) continue;
    const o = i * 16;
    words.set([l.op, mc, l.a, l.b, a.x, a.z, a.w, a.h, a.offset, 0, Number(l.st & 0xffffffffn), Number(l.st >> 32n), Number(l.ss & 0xffffffffn), Number(l.ss >> 32n), 0, 0], o);
  }
  return words;
}
/** Each layer is a real compute dispatch reading previously generated layers.
 * Only seed-derived permutations / LCG salts and area metadata are uploaded.
 * No CPU biome evaluation is used by this runner.
 */
export class LegacyGpu {
  readonly layers: Layer[];
  private noiseWords: Uint32Array | null = null;
  private seed: bigint | null = null;
  private destroyed = false;
  private constructor(
    readonly device: GPUDevice, readonly version: number, readonly largeBiomes: boolean,
    private readonly layout: GPUBindGroupLayout,
    private readonly pipeline: GPUComputePipeline,
    private readonly gatherPipeline: GPUComputePipeline,
  ) { this.layers = makeStack(version, largeBiomes); }
  static async create(device: GPUDevice, version: number, largeBiomes = false): Promise<LegacyGpu> {
    makeStack(version, largeBiomes);
    const module = device.createShaderModule({ code: LEGACY_SHADER_BASE + LEGACY_SHADER_RULES + ENTRY_POINTS });
    const errors = (await module.getCompilationInfo()).messages.filter(m => m.type === 'error');
    if (errors.length) throw new Error(`Legacy WGSL compilation failed:\n${errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n')}`);
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipeline = await device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint: 'main' } });
    const gatherPipeline = await device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint: 'gather' } });
    return new LegacyGpu(device, version, largeBiomes, layout, pipeline, gatherPipeline);
  }
  setSeed(seed: bigint): void {
    if (this.destroyed) throw new Error('LegacyGpu is destroyed');
    if (seed < -(1n << 63n) || seed >= 1n << 63n) throw new RangeError('Seed must be signed 64-bit');
    if (this.seed === seed) return;
    seedStack(this.layers, seed);
    const noise = new ImprovedNoise(new LegacyRandom(seed));
    const words = new Uint32Array(265), floats = new Float32Array(words.buffer);
    words.set(noise.perm);
    for (const [i, value] of [noise.xo, noise.yo, noise.zo].entries()) {
      const o = 256 + i * 3, whole = Math.floor(value), frac = value - whole;
      words[o] = whole; floats[o + 1] = frac; floats[o + 2] = frac - floats[o + 1]!;
    }
    this.noiseWords = words; this.seed = seed;
  }
  async run(r: Region): Promise<GpuResult> {
    if (this.destroyed) throw new Error('LegacyGpu is destroyed');
    if (!this.noiseWords) throw new Error('setSeed() first');
    const d = this.device;
    const result = new Uint32Array(r.w * r.h);
    const side = Math.max(1, Math.min(128, Math.floor(512 / r.step)));
    const snapshot = this.layers.map(l => ({ ...l }));
    const noiseBuffer = storage(d, this.noiseWords.byteLength, this.noiseWords);
    const stride = Math.max(256, d.limits.minUniformBufferOffsetAlignment);
    const t0 = performance.now();
    try {
      for (let tz = 0; tz < r.h; tz += side) for (let tx = 0; tx < r.w; tx += side) {
        const tw = Math.min(side, r.w - tx), th = Math.min(side, r.h - tz);
        const rect = { x: r.x0 + tx * r.step, z: r.z0 + tz * r.step, w: (tw - 1) * r.step + 1, h: (th - 1) * r.step + 1 };
        const plan = planStack(snapshot, rect);
        if (plan.size * 4 > Math.min(d.limits.maxStorageBufferBindingSize, d.limits.maxBufferSize)) throw new RangeError('Layered region exceeds WebGPU storage limit');
        if ((snapshot.length + 1) * stride > d.limits.maxBufferSize) throw new RangeError('Layer metadata exceeds WebGPU buffer limit');
        for (const area of plan.areas) {
          if (area && Math.ceil(area.w * area.h / 64) > d.limits.maxComputeWorkgroupsPerDimension) throw new RangeError('Layered region exceeds WebGPU dispatch limit');
        }
        const metadata = packLayers(snapshot, plan, this.version);
        const metaBuffer = storage(d, metadata.byteLength, metadata);
        const dataBuffer = storage(d, plan.size * 4);
        const outputBuffer = storage(d, tw * th * 4);
        const readback = d.createBuffer({ size: tw * th * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const parameters = new Int32Array((snapshot.length + 1) * stride / 4);
        for (let i = 0; i < snapshot.length; i++) parameters[i * stride / 4] = i;
        parameters.set([snapshot.length - 1, r.step, tw, th], snapshot.length * stride / 4);
        const uniform = d.createBuffer({ size: parameters.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        d.queue.writeBuffer(uniform, 0, parameters);
        try {
          const bind = d.createBindGroup({ layout: this.layout, entries: [
            { binding: 0, resource: { buffer: uniform, size: 16 } },
            { binding: 1, resource: { buffer: metaBuffer } },
            { binding: 2, resource: { buffer: dataBuffer } },
            { binding: 3, resource: { buffer: noiseBuffer } },
            { binding: 4, resource: { buffer: outputBuffer } },
          ] });
          const encoder = d.createCommandEncoder();
          // Separate passes make the storage read-after-write ordering explicit.
          for (let i = 0; i < snapshot.length; i++) {
            const area = plan.areas[i]; if (!area) continue;
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.pipeline); pass.setBindGroup(0, bind, [i * stride]);
            pass.dispatchWorkgroups(Math.ceil(area.w * area.h / 64)); pass.end();
          }
          const gather = encoder.beginComputePass();
          gather.setPipeline(this.gatherPipeline); gather.setBindGroup(0, bind, [snapshot.length * stride]);
          gather.dispatchWorkgroups(Math.ceil(tw * th / 64)); gather.end();
          encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, tw * th * 4);
          d.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const tile = new Uint32Array(readback.getMappedRange());
          for (let z = 0; z < th; z++) result.set(tile.subarray(z * tw, (z + 1) * tw), tx + (tz + z) * r.w);
          readback.unmap();
        } finally {
          uniform.destroy(); metaBuffer.destroy(); dataBuffer.destroy(); outputBuffer.destroy(); readback.destroy();
        }
      }
      return { biomes: result, gpuMs: performance.now() - t0 };
    } finally { noiseBuffer.destroy(); }
  }
  destroy(): void { this.destroyed = true; this.noiseWords = null; }
}

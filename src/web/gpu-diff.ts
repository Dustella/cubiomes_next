// Browser entry used by tools/gpu-diff.ts: runs the GPU and CPU paths on the
// same region and reports mismatches. Exposed as window.gpuDiff.

import { BiomeGenerator, DimensionModel } from '../core/generator';
import { parseSeed } from '../core/rng';
import { GpuBiomeRunner, type Region } from '../gpu/runner';

export interface DiffReport {
  adapter: string;
  dimension: string;
  samples: number;
  biomeMismatch: number;
  climateMismatch: number[];
  climateMaxDelta: number[];
  gpuMs: number;
  cpuMs: number;
  examples: string[];
}

const runners = new Map<string, Promise<{ runner: GpuBiomeRunner; adapter: GPUAdapter }>>();

function getRunner(bundleUrl: string, dimension: string): Promise<{ runner: GpuBiomeRunner; adapter: GPUAdapter }> {
  const key = `${bundleUrl}#${dimension}`;
  let r = runners.get(key);
  if (!r) {
    r = (async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) throw new Error('WebGPU adapter unavailable');
      const device = await adapter.requestDevice();
      const model = DimensionModel.fromBundle(await (await fetch(bundleUrl)).json(), dimension);
      return { runner: await GpuBiomeRunner.create(device, model), adapter };
    })();
    runners.set(key, r);
  }
  return r;
}

async function gpuDiff(bundleUrl: string, dimension: string, seedText: string, region: Region): Promise<DiffReport> {
  const { runner, adapter } = await getRunner(bundleUrl, dimension);
  const model = runner.model;
  const seed = parseSeed(seedText);
  runner.setSeed(seed);
  const gpu = await runner.run(region, model.index !== null);

  const cpu = new BiomeGenerator(model, seed);
  const climateMismatch = [0, 0, 0, 0, 0, 0], climateMaxDelta = [0, 0, 0, 0, 0, 0];
  let biomeMismatch = 0;
  const examples: string[] = [];
  const t0 = performance.now();
  for (let s = 0; s < region.w * region.h; s++) {
    const qx = region.x0 + (s % region.w) * region.step, qz = region.z0 + Math.floor(s / region.w) * region.step;
    if (gpu.climate) {
      const t = cpu.climate(qx, region.qy, qz);
      for (let a = 0; a < 6; a++) {
        const d = Math.abs(gpu.climate[s * 6 + a]! - t[a]!);
        if (d) { climateMismatch[a]!++; climateMaxDelta[a] = Math.max(climateMaxDelta[a]!, d); }
      }
    }
    const b = cpu.biome(qx, region.qy, qz);
    if (b !== gpu.biomes[s]) {
      biomeMismatch++;
      if (examples.length < 6) examples.push(`(${qx},${region.qy},${qz}) cpu=${model.biomes[b]} gpu=${model.biomes[gpu.biomes[s]!]}`);
    }
  }
  return {
    adapter: `${adapter.info.vendor}/${adapter.info.architecture}`,
    dimension, samples: region.w * region.h, biomeMismatch, climateMismatch, climateMaxDelta,
    gpuMs: gpu.gpuMs, cpuMs: performance.now() - t0, examples,
  };
}

declare global {
  interface Window { gpuDiff: typeof gpuDiff }
}
window.gpuDiff = gpuDiff;

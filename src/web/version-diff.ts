// Hardware WebGPU + CPU versus independent native Cubiomes fixtures.
import { CpuBiomeGenerator, GpuVersionBiomeRunner } from '../library';
import type { BiomeOptions } from '../library';
import type { VerificationCase } from '../../tools/version-fixtures';

interface CaseReport {
  index: number;
  version: string;
  dimension: string;
  seed: string;
  largeBiomes: boolean;
  samples: number;
  cpuMismatch: number;
  gpuMismatch: number;
  gpuMs: number;
  examples: string[];
  error?: string;
}

let fixtures: VerificationCase[];
let device: GPUDevice;
let current: GpuVersionBiomeRunner | undefined;
let currentKey = '';
const reports: CaseReport[] = [];

async function initialize(): Promise<{ adapter: string; cases: number }> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  device = await adapter.requestDevice();
  fixtures = await (await fetch('/verification/version-fixtures.json')).json();
  const result = { adapter: `${adapter.info.vendor}/${adapter.info.architecture}`, cases: fixtures.length };
  document.querySelector('pre')!.textContent = JSON.stringify(result, null, 2);
  return result;
}

async function runCases(start: number, end: number): Promise<CaseReport[]> {
  const batch: CaseReport[] = [];
  for (let index = start; index < Math.min(end, fixtures.length); index++) {
    const c = fixtures[index]!;
    const report: CaseReport = { index, version: c.version, dimension: c.dimension, seed: c.seed,
      largeBiomes: c.largeBiomes, samples: c.expected.length, cpuMismatch: 0, gpuMismatch: 0, gpuMs: 0, examples: [] };
    try {
      const options: BiomeOptions = { version: c.version, dimension: c.dimension, seed: BigInt(c.seed), largeBiomes: c.largeBiomes };
      const cpu = new CpuBiomeGenerator(options).run(c.region);
      const key = `${c.version}/${c.dimension}/${c.largeBiomes}`;
      if (key !== currentKey) {
        current?.destroy();
        current = undefined;
        currentKey = '';
        current = await GpuVersionBiomeRunner.create(device, options);
        currentKey = key;
      } else {
        current!.setSeed(options.seed);
      }
      const gpu = await current!.run(c.region);
      report.gpuMs = gpu.gpuMs;
      for (let s = 0; s < c.expected.length; s++) {
        const expected = c.expected[s]!;
        if (cpu[s] !== expected) report.cpuMismatch++;
        if (gpu.biomes[s] !== expected) report.gpuMismatch++;
        if ((cpu[s] !== expected || gpu.biomes[s] !== expected) && report.examples.length < 5) {
          const x = c.region.x0 + (s % c.region.w) * c.region.step;
          const z = c.region.z0 + Math.floor(s / c.region.w) * c.region.step;
          report.examples.push(`(${x},${c.region.qy},${z}) oracle=${expected} cpu=${cpu[s]} gpu=${gpu.biomes[s]}`);
        }
      }
    } catch (error) {
      report.error = String(error);
    }
    reports.push(report);
    batch.push(report);
    document.querySelector('pre')!.textContent = JSON.stringify({ completed: reports.length,
      cpuMismatch: reports.reduce((n, r) => n + r.cpuMismatch, 0), gpuMismatch: reports.reduce((n, r) => n + r.gpuMismatch, 0),
      errors: reports.filter(r => r.error), last: report }, null, 2);
  }
  return batch;
}

function release(): void {
  current?.destroy();
  current = undefined;
  currentKey = '';
  device?.destroy();
}

declare global {
  interface Window {
    releaseVerification: { initialize: typeof initialize; runCases: typeof runCases; reports: CaseReport[]; release: typeof release };
  }
}
window.releaseVerification = { initialize, runCases, reports, release };

// Independent native Cubiomes fixtures exercised through the actual worker API.
import { StructureWorker } from '../structures/client';
import { STRUCTURE_VERSIONS } from '../structures/catalog';
import type { StructureRequest, StructureResponse } from '../structures/types';

interface Fixture {
  world: { mc: number; seed: string; largeBiomes: boolean };
  request: StructureRequest;
  expected: StructureResponse;
}
interface Report {
  index: number;
  version: string;
  operation: string;
  equal: boolean;
  ms: number;
  error?: string;
  expected?: unknown;
  actual?: unknown;
}
let fixtures: Fixture[] = [];
let current: StructureWorker | undefined;
let currentKey = '';
const reports: Report[] = [];
let heartbeat = 0;
const timer = setInterval(() => heartbeat++, 10);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function initialize(): Promise<{ cases: number; worker: string; wasm: string }> {
  const response = await fetch('/verification/structure-fixtures.json');
  if (!response.ok) throw new Error(`Loading native fixtures failed: HTTP ${response.status}`);
  fixtures = await response.json();
  const result = { cases: fixtures.length, worker: '/structure-worker.js', wasm: '/structures.wasm' };
  document.querySelector('pre')!.textContent = JSON.stringify(result, null, 2);
  return result;
}

async function runCases(start: number, end: number): Promise<Report[]> {
  const batch: Report[] = [];
  for (let index = start; index < Math.min(end, fixtures.length); index++) {
    const c = fixtures[index]!;
    const version = STRUCTURE_VERSIONS.find(v => v.mc === c.world.mc);
    if (!version) throw new Error(`Invalid fixture version ${c.world.mc}`);
    const before = performance.now();
    const report: Report = { index, version: version.id, operation: c.request.op, equal: false, ms: 0 };
    try {
      const key = `${version.id}/${c.world.seed}/${c.world.largeBiomes}`;
      if (key !== currentKey) {
        current?.terminate();
        current = undefined;
        currentKey = '';
        current = await StructureWorker.create({ version: version.id, seed: BigInt(c.world.seed), largeBiomes: c.world.largeBiomes });
        currentKey = key;
      }
      const result = await current!.execute(c.request);
      report.equal = canonical(result) === canonical(c.expected);
      if (!report.equal) { report.expected = c.expected; report.actual = result; }
    } catch (error) {
      report.error = String(error);
    }
    report.ms = performance.now() - before;
    reports.push(report);
    batch.push(report);
    document.querySelector('pre')!.textContent = JSON.stringify({ completed: reports.length,
      failures: reports.filter(r => !r.equal).length, heartbeat, last: report }, null, 2);
  }
  return batch;
}

function release(): void {
  current?.terminate();
  current = undefined;
  currentKey = '';
  clearInterval(timer);
}

declare global {
  interface Window {
    structureVerification: { initialize: typeof initialize; runCases: typeof runCases; reports: Report[]; release: typeof release; heartbeat: () => number };
  }
}
window.structureVerification = { initialize, runCases, reports, release, heartbeat: () => heartbeat };

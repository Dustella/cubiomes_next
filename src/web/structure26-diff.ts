import { BundleStructureWorker } from '../structures/bundle-client';
import type { Structure26Fixture } from '../../tools/check-structure26';

interface Report { index: number; operation: string; equal: boolean; ms: number; error?: string; expected?: unknown; actual?: unknown }
let fixtures: Structure26Fixture[] = [];
let current: BundleStructureWorker | undefined;
let currentKey = '';
const reports: Report[] = [];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
async function initialize(): Promise<{ cases: number }> {
  const response = await fetch('/verification/structure26-official.json');
  if (!response.ok) throw new Error(`Loading 26.2 fixtures failed: HTTP ${response.status}`);
  const oracle = await response.json() as { fixtures: Structure26Fixture[] };
  fixtures = oracle.fixtures;
  const result = { cases: fixtures.length };
  document.querySelector('pre')!.textContent = JSON.stringify(result, null, 2);
  return result;
}
async function runCases(start: number, end: number): Promise<Report[]> {
  const batch: Report[] = [];
  for (let index = start; index < Math.min(end, fixtures.length); index++) {
    const c = fixtures[index]!;
    const report: Report = { index, operation: c.request.op, equal: false, ms: 0 };
    const time = performance.now();
    try {
      const key = `${c.world.seed}/${c.world.dimension}/${c.world.preset ?? 'normal'}`;
      if (key !== currentKey) {
        current?.terminate(); current = undefined; currentKey = '';
        current = await BundleStructureWorker.create({ ...c.world, seed: BigInt(c.world.seed) }, { bundle: '/bundles/26.2.structures.bundle.json' });
        currentKey = key;
      }
      const actual = await current!.execute(c.request);
      report.equal = canonical(actual) === canonical(c.expected);
      if (!report.equal) { report.actual = actual; report.expected = c.expected; }
    } catch (error) { report.error = String(error); }
    report.ms = performance.now() - time;
    reports.push(report); batch.push(report);
    document.querySelector('pre')!.textContent = JSON.stringify({ completed: reports.length, failed: reports.filter(r => !r.equal).length, last: report }, null, 2);
  }
  return batch;
}
function release(): void { current?.terminate(); current = undefined; currentKey = ''; }
declare global {
  interface Window { structure26Verification: { initialize: typeof initialize; runCases: typeof runCases; reports: Report[]; release: typeof release } }
}
window.structure26Verification = { initialize, runCases, reports, release };

// Actual worker versus independent official-runtime fixtures. The official
// bundle and fixture dumps are local ignored inputs, never embedded in code.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BundleStructureWorker } from '../src/structures/bundle-client';
import { frequencyPass } from '../src/structures/bundle-random';
import type { BundleDimension, BundleFrequencyMethod, BundleStructureRequest, BundleStructureResponse, StructureBundle } from '../src/structures/bundle-schema';

export interface Structure26Fixture {
  world: { seed: string; dimension: BundleDimension; preset?: string };
  request: BundleStructureRequest;
  expected: BundleStructureResponse;
}
interface ReducerProbe { method: BundleFrequencyMethod; seed: string; x: number; z: number; salt: number; frequency: number; pass: boolean; structureChunkPass: boolean }
interface OracleOutput {
  oracle: string; fixtures: Structure26Fixture[]; reducerProbes: ReducerProbe[];
  starts: { valid?: boolean; error?: string }[];
  placementStarts: { valid?: boolean; error?: string }[];
}
const root = resolve(import.meta.dir, '..');
const fixturePath = resolve(Bun.argv[2] ?? `${root}/gt-out/structure26-official.json`);
const bundlePath = resolve(Bun.argv[3] ?? `${root}/bundles/26.2.structures.bundle.json`);
const oracle: OracleOutput = await Bun.file(fixturePath).json();
if (oracle.oracle !== 'official-26.2-public-api' || !Array.isArray(oracle.fixtures)) throw new TypeError('Expected official 26.2 oracle output');
const fixtures = oracle.fixtures;
const bundle: StructureBundle = await Bun.file(bundlePath).json();
const workerURL = pathToFileURL(resolve(root, 'public/structure-worker.js'));
const totals = new Map<string, { cases: number; mismatches: number; errors: number }>();
const failures: object[] = [];
let current: BundleStructureWorker | undefined;
let currentKey = '';
let ticks = 0;
const timer = setInterval(() => ticks++, 10);
const started = performance.now();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
try {
  for (let index = 0; index < fixtures.length; index++) {
    const c = fixtures[index]!;
    const key = `${c.world.seed}/${c.world.dimension}/${c.world.preset ?? 'normal'}`;
    if (key !== currentKey) {
      current?.terminate();
      current = undefined;
      currentKey = '';
      current = await BundleStructureWorker.create({ ...c.world, seed: BigInt(c.world.seed) }, { workerURL, bundle });
      currentKey = key;
    }
    const total = totals.get(c.request.op) ?? { cases: 0, mismatches: 0, errors: 0 };
    total.cases++;
    try {
      const actual = await current!.execute(c.request);
      if (canonical(actual) !== canonical(c.expected)) {
        total.mismatches++;
        if (failures.length < 12) failures.push({ index, world: c.world, request: c.request, expected: c.expected, actual });
      }
    } catch (error) {
      total.errors++;
      if (failures.length < 12) failures.push({ index, world: c.world, request: c.request, error: String(error) });
    }
    totals.set(c.request.op, total);
  }
} finally {
  current?.terminate();
  clearInterval(timer);
}
let reducerMismatch = 0;
for (const probe of oracle.reducerProbes) {
  const actual = frequencyPass(BigInt(probe.seed), probe.x, probe.z, { salt: probe.salt, frequency: probe.frequency,
    frequencyReductionMethod: probe.method, locateOffset: [0, 0, 0] });
  if (actual !== probe.structureChunkPass || probe.pass !== probe.structureChunkPass) {
    reducerMismatch++;
    if (failures.length < 12) failures.push({ reducer: probe, actual });
  }
}
const report = { cases: fixtures.length, version: bundle.version, sets: Object.keys(bundle.sets).length,
  dimensions: [...new Set(fixtures.map(c => c.world.dimension))], operations: Object.fromEntries(totals), failures, ticks,
  reducerProbes: { cases: oracle.reducerProbes.length, mismatches: reducerMismatch },
  officialStartProbes: { total: oracle.placementStarts.length, valid: oracle.placementStarts.filter(s => s.valid).length,
    invalid: oracle.placementStarts.filter(s => s.valid === false).length, errors: oracle.placementStarts.filter(s => s.error).length },
  wallMs: performance.now() - started };
await Bun.write(resolve(root, 'gt-out/structure26-worker-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = reducerMismatch || [...totals.values()].some(t => t.mismatches || t.errors) ? 1 : 0;

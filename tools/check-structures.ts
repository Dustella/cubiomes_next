// Runs real dedicated workers, not a main-thread or native fallback.
// Usage: bun tools/check-structures.ts [gt-out/structure-fixtures.json]
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StructureWorker } from '../src/structures/client';
import { STRUCTURE_VERSIONS } from '../src/structures/catalog';
import type { StructureRequest, StructureResponse } from '../src/structures/types';

interface Fixture {
  world: { mc: number; seed: string; largeBiomes: boolean };
  request: StructureRequest;
  expected: StructureResponse;
}
const root = resolve(import.meta.dir, '..');
const fixtures: Fixture[] = await Bun.file(resolve(Bun.argv[2] ?? `${root}/gt-out/structure-fixtures.json`)).json();
const wasm = new Uint8Array(await Bun.file(resolve(root, 'public/structures.wasm')).arrayBuffer());
const workerURL = pathToFileURL(resolve(root, 'public/structure-worker.js'));
const totals = new Map<string, { cases: number; mismatches: number; errors: number }>();
const failures: object[] = [];
let current: StructureWorker | undefined;
let currentKey = '';
let heartbeat = 0;
const timer = setInterval(() => heartbeat++, 10);
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
    const version = STRUCTURE_VERSIONS.find(v => v.mc === c.world.mc);
    if (!version) throw new Error(`Invalid fixture version ${c.world.mc}`);
    const total = totals.get(c.request.op) ?? { cases: 0, mismatches: 0, errors: 0 };
    total.cases++;
    try {
      const key = `${version.id}/${c.world.seed}/${c.world.largeBiomes}`;
      if (key !== currentKey) {
        current?.terminate();
        current = undefined;
        currentKey = '';
        current = await StructureWorker.create({ version: version.id, seed: BigInt(c.world.seed), largeBiomes: c.world.largeBiomes }, { workerURL, wasm });
        currentKey = key;
      }
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
const report = { cases: fixtures.length, versions: new Set(fixtures.map(c => c.world.mc)).size,
  operations: Object.fromEntries(totals), failures, heartbeat, wallMs: performance.now() - started };
await Bun.write(resolve(root, 'gt-out/structure-worker-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = [...totals.values()].some(t => t.mismatches || t.errors) ? 1 : 0;

// Usage: bun tools/check-releases.ts [gt-out/version-fixtures.json]
// Fixtures must first be generated against the native Cubiomes oracle.
import { resolve } from 'node:path';
import { CpuBiomeGenerator } from '../src';
import type { VerificationCase } from './version-fixtures';

const file = resolve(Bun.argv[2] ?? `${import.meta.dir}/../gt-out/version-fixtures.json`);
const cases: VerificationCase[] = await Bun.file(file).json();
const totals = new Map<string, { cases: number; samples: number; mismatches: number }>();
const examples: object[] = [];
const start = performance.now();
for (const c of cases) {
  const cpu = new CpuBiomeGenerator({ version: c.version, dimension: c.dimension, seed: BigInt(c.seed), largeBiomes: c.largeBiomes });
  const result = cpu.run(c.region);
  const total = totals.get(c.dimension) ?? { cases: 0, samples: 0, mismatches: 0 };
  total.cases++;
  total.samples += c.expected.length;
  if (result.length !== c.expected.length) throw new Error('Wrong output size');
  for (let i = 0; i < result.length; i++) {
    if (result[i] !== c.expected[i]) {
      total.mismatches++;
      if (examples.length < 20) examples.push({ version: c.version, dimension: c.dimension, seed: c.seed, largeBiomes: c.largeBiomes,
        x: c.region.x0 + (i % c.region.w) * c.region.step, y: c.region.qy,
        z: c.region.z0 + Math.floor(i / c.region.w) * c.region.step, expected: c.expected[i], actual: result[i] });
    }
  }
  totals.set(c.dimension, total);
}
const report = { fixture: file, versions: new Set(cases.map(c => c.version)).size,
  dimensions: Object.fromEntries(totals), examples, cpuMs: performance.now() - start };
console.log(JSON.stringify(report, null, 2));
process.exitCode = [...totals.values()].some(t => t.mismatches !== 0) ? 1 : 0;

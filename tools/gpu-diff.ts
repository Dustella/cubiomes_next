// Runs the GPU path in headless Chrome and diffs it against the CPU reference.
//
// Usage: bun tools/gpu-diff.ts --chrome <chrome binary> [--bundle 26.2.bundle.json]
//          [--dims overworld,nether,end] [--seeds 12345,hello] [--x Q --z Q --w N --h N --step N --y Q]
// One browser session runs the whole dims x seeds matrix (shader compile dominates).

import { launch } from './headless';
import type { DiffReport } from '../src/web/gpu-diff';

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i += 2) args.set(Bun.argv[i]!.replace(/^--/, ''), Bun.argv[i + 1] ?? '');
const chrome = args.get('chrome') ?? process.env.CHROME;
if (!chrome) throw new Error('--chrome or $CHROME required');
const num = (k: string, d: number): number => Number(args.get(k) ?? d);
const region = { x0: num('x', -512), z0: num('z', -512), w: num('w', 256), h: num('h', 256), step: num('step', 4), qy: num('y', 16) };
const bundle = `/bundles/${args.get('bundle') ?? '26.2.bundle.json'}`;
const dims = (args.get('dims') ?? 'overworld').split(',');
const seeds = (args.get('seeds') ?? '12345').split(',');

const port = 8790 + Math.floor(Math.random() * 100);
const server = Bun.spawn(['bun', 'tools/serve.ts', '--port', String(port)], { cwd: `${import.meta.dir}/..`, stdout: 'ignore', stderr: 'inherit' });
await Bun.sleep(500);
const page = await launch(chrome, `http://127.0.0.1:${port}/gpu-diff.html`);
let failed = false;
try {
  for (const dim of dims) {
    for (const seed of seeds) {
      const report = await page.evaluate<DiffReport>(`window.gpuDiff(${JSON.stringify(bundle)}, ${JSON.stringify(dim)}, ${JSON.stringify(seed)}, ${JSON.stringify(region)})`);
      const c = report.climateMismatch.map((m, i) => `${'THCEDW'[i]}=${m}${m ? `(±${report.climateMaxDelta[i]})` : ''}`).join(' ');
      console.log(`${report.adapter} ${dim} seed=${seed} n=${report.samples} biome-mismatch=${report.biomeMismatch} (${(100 * report.biomeMismatch / report.samples).toFixed(3)}%) climate[${c}] gpu=${report.gpuMs.toFixed(0)}ms cpu=${report.cpuMs.toFixed(0)}ms`);
      for (const e of report.examples) console.log(`  ${e}`);
      if (report.biomeMismatch) failed = true;
    }
  }
} finally {
  page.close();
  server.kill();
}
process.exitCode = failed ? 1 : 0;

// Generates independent Cubiomes expected values for the release verification page.
// Build the C oracle first; no official game files are used.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { SUPPORTED_VERSIONS } from '../src/versions';
import type { Region } from '../src/gpu/runner';

export interface VerificationCase {
  version: string;
  dimension: 'overworld' | 'nether' | 'end';
  seed: string;
  largeBiomes: boolean;
  region: Region;
  expected: number[];
}

const root = resolve(import.meta.dir, '..');
const oracle = resolve(Bun.argv[2] ?? `${root}/gt-out/version-oracle${process.platform === 'win32' ? '.exe' : ''}`);
const cases: VerificationCase[] = [];
const positions: { seed: string; region: Region }[] = [
  { seed: '0', region: { x0: -17, z0: -19, w: 16, h: 12, step: 3, qy: 16 } },
  { seed: '-1', region: { x0: 257, z0: -4097, w: 16, h: 12, step: 17, qy: -12 } },
  { seed: '9223372036854775807', region: { x0: -7000000, z0: 6999000, w: 12, h: 8, step: 31, qy: -60 } },
  { seed: '-9223372036854775808', region: { x0: 1023, z0: -1025, w: 12, h: 8, step: 129, qy: 80 } },
  { seed: '12345', region: { x0: -128, z0: -128, w: 16, h: 16, step: 16, qy: 0 } },
];
for (const version of SUPPORTED_VERSIONS) {
  for (const dimension of ['overworld', 'nether', 'end'] as const) {
    for (const { seed, region } of positions) {
      const presets = dimension === 'overworld' && version.mc >= 6 ? [false, true] : [false];
      for (const largeBiomes of presets) {
        const dim = dimension === 'nether' ? -1 : dimension === 'end' ? 1 : 0;
        const proc = Bun.spawn([oracle, String(version.mc), String(dim), seed,
          String(region.x0), String(region.z0), String(region.w), String(region.h),
          String(region.step), String(region.qy), largeBiomes ? '1' : '0', '4'],
          { stdout: 'pipe', stderr: 'pipe' });
        const [bytes, error, status] = await Promise.all([
          new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited,
        ]);
        if (status !== 0) throw new Error(`Cubiomes ${version.id}/${dimension}: ${error}`);
        if (bytes.byteLength !== region.w * region.h * 4) throw new Error('Truncated oracle output');
        const view = new DataView(bytes);
        const expected = Array.from({ length: region.w * region.h }, (_, i) => view.getInt32(i * 4, true));
        cases.push({ version: version.id, dimension, seed, region, largeBiomes, expected });
      }
    }
  }
}
mkdirSync(resolve(root, 'gt-out'), { recursive: true });
const output = resolve(root, 'gt-out/version-fixtures.json');
await Bun.write(output, JSON.stringify(cases));
console.log(JSON.stringify({ oracle, cases: cases.length, samples: cases.reduce((n, c) => n + c.expected.length, 0), output }));

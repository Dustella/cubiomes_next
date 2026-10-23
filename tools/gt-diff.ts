// Diffs our CPU generator against a ground-truth oracle.
//
// Oracles:
//   official (default): tools/gt/GtSample.java calls public APIs of a locally
//     run, unobfuscated (26.1+) server jar and emits numbers only.
//   cubiomes: tools/cubiomes-gt.c, for versions cubiomes supports (<= 1.21 WD)
//     whose jars are obfuscated. Nether climate is not exposed by cubiomes, so
//     only biomes are compared there.
// Dumps go to gt-out/ (gitignored).
//
// Usage:
//   bun tools/gt-diff.ts --bundle <bundle.json> (--server-dir <unbundled server dir> | --oracle cubiomes --cubiomes <dir>)
//       [--preset overworld|large_biomes|amplified|nether] [--seed N] [--x Q --z Q --w N --h N --step N --y Q]

import { mkdirSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BiomeGenerator, DimensionModel } from '../src/core/generator';
import { parseSeed } from '../src/core/rng';

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i += 2) args.set(Bun.argv[i]!.replace(/^--/, ''), Bun.argv[i + 1] ?? '');
const oracle = args.get('oracle') ?? 'official';
const preset = args.get('preset') ?? 'overworld';
const seedText = args.get('seed') ?? '12345';
const num = (k: string, d: number): number => Number(args.get(k) ?? d);
const [x0, z0, w, h, step, y] = [num('x', -256), num('z', -256), num('w', 128), num('h', 128), num('step', 4), num('y', 16)];

function jars(dir: string): string[] {
  const res: string[] = [];
  const rec = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) rec(p);
      else if (n.endsWith('.jar')) res.push(p);
    }
  };
  rec(dir);
  return res;
}

async function sh(cmd: string[], cwd?: string): Promise<void> {
  const p = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'pipe' });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${(await new Response(p.stderr).text()).slice(-3000)}`);
}

const seed = parseSeed(seedText);
const outDir = resolve(import.meta.dir, '..', 'gt-out');
mkdirSync(outDir, { recursive: true });
const tag = oracle === 'official' ? `official-${resolve(args.get('server-dir') ?? '').replace(/[^A-Za-z0-9.]+/g, '_')}` : 'cubiomes';
const outFile = join(outDir, `${tag}_${preset}_${seed}_${x0}_${z0}_${w}x${h}s${step}y${y}.bin`);
let compareClimate = true;

if (oracle === 'official') {
  // Classpath: the unbundled server jar under versions/ plus libraries/ (created by the bundler on first launch).
  const serverDir = resolve(args.get('server-dir') ?? '');
  const versionJars = jars(join(serverDir, 'versions'));
  if (versionJars.length !== 1) throw new Error(`expected one jar under ${serverDir}/versions (run the server jar once to unbundle)`);
  const cp = [versionJars[0]!, ...jars(join(serverDir, 'libraries'))].join(':');
  const gtDir = resolve(import.meta.dir, 'gt');
  if (!existsSync(join(gtDir, 'GtSample.class'))) await sh(['javac', '-nowarn', '-cp', cp, '-d', gtDir, join(gtDir, 'GtSample.java')]);
  if (!existsSync(outFile)) {
    await sh(['java', '-cp', `${cp}:${gtDir}`, 'GtSample', preset, String(seed), String(x0), String(z0), String(w), String(h), String(step), String(y), outFile]);
  }
} else if (oracle === 'cubiomes') {
  if (preset === 'amplified') throw new Error('cubiomes oracle does not model amplified');
  const cub = resolve(args.get('cubiomes') ?? '');
  const bin = join(outDir, 'cubiomes-gt');
  if (!existsSync(bin)) {
    await sh(['make', '-C', cub, 'release']);
    await sh(['cc', '-O2', '-fwrapv', `-I${cub}`, resolve(import.meta.dir, 'cubiomes-gt.c'), join(cub, 'libcubiomes.a'), '-lm', '-o', bin]);
  }
  if (!existsSync(outFile)) {
    await sh([bin, preset, String(seed), String(x0), String(z0), String(w), String(h), String(step), String(y), outFile]);
  }
  compareClimate = preset !== 'nether';
} else {
  throw new Error(`unknown oracle ${oracle}`);
}

const buf = readFileSync(outFile);
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const names = readFileSync(`${outFile}.names`, 'utf8').split('\n');
const n = view.getInt32(0, true);

const model = DimensionModel.fromBundle(JSON.parse(readFileSync(args.get('bundle') ?? '', 'utf8')), preset);
const gen = new BiomeGenerator(model, seed);
const AX = ['temperature', 'humidity', 'continentalness', 'erosion', 'depth', 'weirdness'];
const climateMismatch = new Array(6).fill(0);
const maxDelta = new Array(6).fill(0);
let biomeMismatch = 0, biomeMismatchSameClimate = 0;
const examples: string[] = [];
// GtSample calls getNoiseBiome sequentially on one thread, so the game's
// last-result cache carries across samples; emulate it for the official
// oracle. Cubiomes' tree search has no such cache.
let candidate = -1;
const chainCandidate = oracle === 'official';
const t0 = performance.now();
for (let s = 0; s < n; s++) {
  const off = 4 + s * 52;
  const gtBiome = names[view.getInt32(off, true)]!;
  const qx = x0 + (s % w) * step, qz = z0 + Math.floor(s / w) * step;
  const ours = gen.climate(qx, y, qz);
  let climateOk = true;
  for (let a = 0; compareClimate && a < 6; a++) {
    const g = Number(view.getBigInt64(off + 4 + a * 8, true));
    const d = Math.abs(g - ours[a]!);
    if (d) { climateMismatch[a]++; climateOk = false; maxDelta[a] = Math.max(maxDelta[a], d); }
  }
  let b: string;
  if (model.index) {
    candidate = gen.entry(qx, y, qz, chainCandidate ? candidate : -1);
    b = model.biomes[model.index.entryBiome[candidate]!]!;
  } else {
    b = model.biomes[gen.biome(qx, y, qz)]!;
  }
  if (b !== gtBiome) {
    biomeMismatch++;
    if (climateOk) biomeMismatchSameClimate++;
    if (examples.length < 8) examples.push(`  (${qx},${y},${qz}) gt=${gtBiome} ours=${b} climateOk=${climateOk}`);
  }
}
const ms = performance.now() - t0;
console.log(`version=${model.bundle.version} preset=${preset} seed=${seed} samples=${n} cpu=${ms.toFixed(0)}ms`);
console.log(`climate mismatches: ${AX.map((a, i) => `${a}=${climateMismatch[i]}(max ${maxDelta[i]})`).join(' ')}`);
console.log(`biome mismatches: ${biomeMismatch}/${n} (${biomeMismatchSameClimate} with identical climate)`);
if (examples.length) console.log(examples.join('\n'));
process.exitCode = biomeMismatch === 0 && climateMismatch.every((c) => c === 0) ? 0 : 1;

// Builds a WorldgenBundle from the data files of an official server jar.
//
// Reads only JSON data (data/minecraft/worldgen/**) and the vanilla datagen
// `biome_parameters` report; never decompiles or copies class files. Output
// goes wherever you point it; bundles derived from Mojang data should stay out
// of version control (see .gitignore).
//
// Usage:
//   bun tools/make-bundle.ts --server <server.jar> --out <bundle.json> [--java java]
//   bun tools/make-bundle.ts --data <dir with data/minecraft/worldgen> --reports <reports dir> --version <id> --out <bundle.json>

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { BiomeEntryJson, WorldgenBundle } from '../src/core/bundle';

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i += 2) args.set(Bun.argv[i]!.replace(/^--/, ''), Bun.argv[i + 1] ?? '');
const out = args.get('out');
if (!out) throw new Error('--out is required');

function walkJson(dir: string): Map<string, unknown> {
  const res = new Map<string, unknown>();
  if (!existsSync(dir)) return res;
  const rec = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) rec(p);
      else if (name.endsWith('.json')) res.set(`minecraft:${relative(dir, p).slice(0, -5)}`, JSON.parse(readFileSync(p, 'utf8')));
    }
  };
  rec(dir);
  return res;
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const p = Bun.spawn(cmd, { cwd, stdout: 'ignore', stderr: 'pipe' });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed (${code}): ${(await new Response(p.stderr).text()).slice(-2000)}`);
}

let dataRoot: string;
let reportsRoot: string;
let version: string;
let cleanup: string | null = null;

const server = args.get('server');
if (server) {
  // The vanilla data generator writes worldgen data + reports. It runs the
  // official jar locally; nothing is redistributed.
  const work = mkdtempSync(join(tmpdir(), 'mcbundle-'));
  cleanup = work;
  await run([args.get('java') ?? 'java', '-DbundlerMainClass=net.minecraft.data.Main', '-jar', resolve(server), '--server', '--reports', '--output', 'gen'], work);
  dataRoot = join(work, 'gen');
  reportsRoot = join(work, 'gen', 'reports');
  const listing = await new Response(Bun.spawn(['unzip', '-p', resolve(server), 'version.json']).stdout).text();
  version = (JSON.parse(listing) as { id: string }).id;
} else {
  dataRoot = args.get('data') ?? '';
  reportsRoot = args.get('reports') ?? '';
  version = args.get('version') ?? 'unknown';
  if (!dataRoot || !reportsRoot) throw new Error('need --server or --data + --reports');
}

const wg = join(dataRoot, 'data', 'minecraft', 'worldgen');
const noise = Object.fromEntries(walkJson(join(wg, 'noise'))) as WorldgenBundle['noise'];
const density_function = Object.fromEntries(walkJson(join(wg, 'density_function'))) as WorldgenBundle['density_function'];
const settingsAll = walkJson(join(wg, 'noise_settings'));
const noise_settings: WorldgenBundle['noise_settings'] = {};
for (const [id, s] of settingsAll) {
  const full = s as { legacy_random_source: boolean; noise: { min_y: number; height: number }; noise_router: Record<string, unknown> };
  const r = full.noise_router;
  // Keep only what biome sampling needs; terrain/surface rules are dropped.
  noise_settings[id.replace('minecraft:', '')] = {
    legacy_random_source: full.legacy_random_source,
    noise: { min_y: full.noise.min_y, height: full.noise.height },
    noise_router: {
      temperature: r.temperature, vegetation: r.vegetation, continents: r.continents,
      erosion: r.erosion, depth: r.depth, ridges: r.ridges,
    } as WorldgenBundle['noise_settings'][string]['noise_router'],
  };
}

const biome_parameters: WorldgenBundle['biome_parameters'] = {};
const bpDir = join(reportsRoot, 'biome_parameters', 'minecraft');
for (const name of readdirSync(bpDir)) {
  if (!name.endsWith('.json')) continue;
  const j = JSON.parse(readFileSync(join(bpDir, name), 'utf8')) as { biomes: BiomeEntryJson[] };
  biome_parameters[name.slice(0, -5)] = j.biomes;
}

const dimensions: WorldgenBundle['dimensions'] = {};
const add = (name: string, settings: string, source: WorldgenBundle['dimensions'][string]['source']): void => {
  if (noise_settings[settings] && (source.type !== 'multi_noise' || biome_parameters[source.parameters])) dimensions[name] = { settings, source };
};
add('overworld', 'overworld', { type: 'multi_noise', parameters: 'overworld' });
add('large_biomes', 'large_biomes', { type: 'multi_noise', parameters: 'overworld' });
add('amplified', 'amplified', { type: 'multi_noise', parameters: 'overworld' });
add('nether', 'nether', { type: 'multi_noise', parameters: 'nether' });
add('end', 'end', { type: 'the_end' });

// Drop density functions / noises unreachable from the climate router to keep the bundle small.
const usedDf = new Set<string>();
const usedNoise = new Set<string>();
const visit = (n: unknown): void => {
  if (typeof n === 'string') {
    const id = n.includes(':') ? n : `minecraft:${n}`;
    if (id in density_function && !usedDf.has(id)) { usedDf.add(id); visit(density_function[id]); }
    return;
  }
  if (Array.isArray(n)) { n.forEach(visit); return; }
  if (n && typeof n === 'object') {
    for (const [k, v] of Object.entries(n)) {
      if ((k === 'noise' || k === 'argument') && typeof v === 'string') {
        const id = v.includes(':') ? v : `minecraft:${v}`;
        if (id in noise) usedNoise.add(id);
      }
      visit(v);
    }
  }
};
for (const s of Object.values(noise_settings)) visit(s.noise_router);

const bundle: WorldgenBundle = {
  format: 1,
  version,
  noise: Object.fromEntries(Object.entries(noise).filter(([k]) => usedNoise.has(k))),
  density_function: Object.fromEntries(Object.entries(density_function).filter(([k]) => usedDf.has(k))),
  noise_settings,
  biome_parameters,
  dimensions,
};
writeFileSync(out, JSON.stringify(bundle));
if (cleanup) rmSync(cleanup, { recursive: true, force: true });
console.log(`wrote ${out}: version ${version}, ${Object.keys(bundle.noise).length} noises, ${Object.keys(bundle.density_function).length} density functions, dimensions ${Object.keys(dimensions).join(', ')}`);

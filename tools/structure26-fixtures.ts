// Generate independent official-26.2 API fixtures into ignored gt-out.
// bun tools/structure26-fixtures.ts --server-dir ../official_source/26.2
// Optional: --out gt-out/structure26-official.json --cases <input.json>
// --quick restricts seeds, not structure-set coverage. No engine is imported.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

const options = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i++) {
  const key = Bun.argv[i]!;
  if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
  if (key === '--quick') options.set('quick', 'true');
  else options.set(key.slice(2), Bun.argv[++i] ?? '');
}
const root = resolve(import.meta.dir, '..');
const server = resolve(options.get('server-dir') ?? join(root, '..', 'official_source', '26.2'));
const out = resolve(options.get('out') ?? join(root, 'gt-out', 'structure26-official.json'));
const classes = join(root, 'gt-out', 'structure26-classes');
mkdirSync(classes, { recursive: true });
mkdirSync(dirname(out), { recursive: true });
function jars(dir: string): string[] {
  return readdirSync(dir).sort().flatMap(name => {
    const file = join(dir, name);
    return statSync(file).isDirectory() ? jars(file) : name.endsWith('.jar') ? [file] : [];
  });
}
async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command[0]} exited ${code}`);
}
interface World { seed: string; dimension: 'overworld' | 'nether' | 'end'; preset?: string }
interface FixtureInput { cases: { world: World; request: Record<string, unknown> }[]; reducerProbes: boolean; starts: Record<string, unknown>[]; searchStarts: Record<string, unknown>[] }
function defaultInput(): FixtureInput {
  const data = join(server, 'gen', 'data', 'minecraft', 'worldgen', 'structure_set');
  const sets = readdirSync(data).filter(name => name.endsWith('.json')).sort().map(name => ({
    id: `minecraft:${name.slice(0, -5)}`,
    data: JSON.parse(readFileSync(join(data, name), 'utf8')) as { placement: { type: string }; structures: { structure: string }[] },
  }));
  if (sets.length !== 20) throw new Error(`expected all 20 official26.2 structure sets, got ${sets.length}`);
  const seeds = options.has('quick') ? ['0'] : ['0', '-1', '12345', '-9223372036854775808', '9223372036854775807'];
  const cases: FixtureInput['cases'] = [];
  const starts: FixtureInput['starts'] = [];
  const worlds: World[] = seeds.flatMap(seed => (['overworld', 'nether', 'end'] as const).map(dimension => ({ seed, dimension })));
  if (!options.has('quick')) for (const preset of ['large_biomes', 'amplified']) worlds.push({ seed: '12345', dimension: 'overworld', preset });
  for (const world of worlds) {
    cases.push({ world, request: { op: 'catalog' } });
    for (const set of sets) {
      if (set.data.placement.type.endsWith('concentric_rings')) {
        cases.push({ world, request: { op: 'rings', set: set.id } });
      } else {
        for (const [regionX, regionZ] of [[0, 0], [-1, -1], [1, -2], [-17, 23], [39, -41], [-513, 127]]) {
          cases.push({ world, request: { op: 'position', set: set.id, regionX, regionZ } });
        }
      }
      for (const entry of set.data.structures) {
        for (const [qx, qy, qz] of [[0, 16, 0], [-257, 0, 319], [4096, 64, -8192]]) cases.push({ world, request: { op: 'biome', structure: entry.structure, qx, qy, qz } });
      }
    }
    cases.push({ world, request: { op: 'scan', set: 'minecraft:pillager_outposts', regionX: -5, regionZ: -5, width: 10, height: 10 } });
    cases.push({ world, request: { op: 'scan', set: 'minecraft:mineshafts', regionX: -2, regionZ: -2, width: 5, height: 5 } });
    if (world.seed === '0' && world.dimension === 'overworld') {
      for (let z = -32; z <= 32; z += 8) for (let x = -32; x <= 32; x += 8) starts.push({ world, structure: 'minecraft:buried_treasure', chunkX: x, chunkZ: z });
      starts.push({ world, structure: 'minecraft:mineshaft', chunkX: 0, chunkZ: 0 });
    }
    if (world.seed === '0' && world.dimension === 'nether') {
      for (const [chunkX, chunkZ] of [[0, 0], [-19, 23], [101, -79]]) starts.push({ world, structure: 'minecraft:fortress', chunkX, chunkZ });
    }
  }
  const searchStarts = [
    { world: { seed: '0', dimension: 'overworld' }, set: 'minecraft:buried_treasures', structure: 'minecraft:buried_treasure', radius: 128 },
    { world: { seed: '0', dimension: 'overworld' }, set: 'minecraft:mineshafts', structure: 'minecraft:mineshaft', radius: 24 },
    { world: { seed: '0', dimension: 'nether' }, set: 'minecraft:nether_complexes', structure: 'minecraft:fortress', radius: 2 },
  ];
  return { cases, reducerProbes: true, starts, searchStarts };
}
const input = options.has('cases') ? JSON.parse(readFileSync(resolve(options.get('cases')!), 'utf8')) : defaultInput();
const inputFile = `${out}.input.json`;
writeFileSync(inputFile, JSON.stringify(input));
const runtimeJar = existsSync(join(server, 'inner.jar')) ? join(server, 'inner.jar') : jars(join(server, 'versions'))[0];
if (!runtimeJar) throw new Error(`no official runtime jar found in ${server}`);
const classpath = [runtimeJar, ...jars(join(server, 'libraries'))].join(delimiter);
await run(['javac', '-nowarn', '-cp', classpath, '-d', classes, join(import.meta.dir, 'gt', 'GtStructures26.java')]);
await run(['java', '-Xmx3G', '-cp', [classpath, classes].join(delimiter), 'GtStructures26', inputFile, out]);
const result = JSON.parse(readFileSync(out, 'utf8'));
const starts = result.starts ?? [];
const placementStarts = result.placementStarts ?? [];
const summary = {
  oracle: result.oracle,
  fixtures: result.fixtures.length,
  worlds: new Set(result.fixtures.map((f: { world: World }) => JSON.stringify(f.world))).size,
  sets: [...new Set(result.fixtures.filter((f: { request: { set?: string } }) => f.request.set).map((f: { request: { set: string } }) => f.request.set))],
  reducerProbes: result.reducerProbes?.length ?? 0,
  startProbes: { total: starts.length, valid: starts.filter((s: { valid?: boolean }) => s.valid).length, invalid: starts.filter((s: { valid?: boolean }) => s.valid === false).length, errors: starts.filter((s: { error?: string }) => s.error).length },
  placementStartProbes: { total: placementStarts.length, valid: placementStarts.filter((s: { valid?: boolean }) => s.valid).length, invalid: placementStarts.filter((s: { valid?: boolean }) => s.valid === false).length, errors: placementStarts.filter((s: { error?: string }) => s.error).length },
  startScope: 'Official Structure.generate with real noise terrain queries and biome predicates; non-template structures only, no piece placement or world/chunk population.',
};
writeFileSync(`${out}.summary.json`, JSON.stringify(summary, null, 2));
console.log(`Official oracle output: ${out}`);
console.log(JSON.stringify(summary, null, 2));

// Run: bun tools/build-structures.ts
// Uses only the checked-in MIT Cubiomes snapshot and real WASI libc/libm.
// setup-wasi pins SDK 34.0 + archive SHA256; override only deliberately with WASI_SDK_PATH.
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setupWasi } from './setup-wasi';

const root = resolve(import.meta.dir, '..');
const worker = join(root, 'src/structures/worker.ts');
if (!(await stat(worker).catch(() => undefined))?.isFile()) {
  throw new Error('Missing src/structures/worker.ts; the public worker is required for this build.');
}
const sdk = await setupWasi();
const compiler = join(sdk, 'bin', process.platform === 'win32' ? 'clang.exe' : 'clang');
const output = join(root, 'public');
await mkdir(output, { recursive: true });
const temporaryWasm = join(root, 'gt-out', 'structures.wasm');
await mkdir(join(root, 'gt-out'), { recursive: true });
const exports = ['sb_abi', 'sb_set_world', 'sb_run', 'sb_result_ptr', 'sb_result_len', 'sb_error_ptr', 'sb_destroy'];
const sources = ['finders', 'generator', 'layers', 'biomes', 'biomenoise', 'noise']
  .map(name => `vendor/cubiomes/${name}.c`);
const compilation = Bun.spawn([
  compiler, '--target=wasm32-wasip1', `--sysroot=${join(sdk, 'share', 'wasi-sysroot')}`,
  '-mexec-model=reactor', '-std=c99', '-O2', '-fwrapv', '-fno-fast-math', '-ffp-contract=off',
  '-Ivendor/cubiomes', 'wasm/structures.c', ...sources, '-lm',
  '-Wl,--stack-first', '-Wl,-z,stack-size=8388608',
  '-Wl,--initial-memory=33554432', '-Wl,--max-memory=268435456',
  '-Wl,--export-memory', ...exports.map(name => `-Wl,--export=${name}`),
  '-Wl,--strip-all', '-o', temporaryWasm,
], { cwd: root, stdout: 'inherit', stderr: 'inherit', env: { ...process.env, SOURCE_DATE_EPOCH: '0' } });
if (await compilation.exited !== 0) throw new Error('Cubiomes WASM compilation failed.');

const bundle = await Bun.build({
  entrypoints: [worker], target: 'browser', format: 'esm', minify: false, sourcemap: 'none',
});
if (!bundle.success) {
  await rm(temporaryWasm, { force: true });
  throw new AggregateError(bundle.logs, 'Structure worker bundle failed.');
}
if (bundle.outputs.length !== 1) throw new Error(`Expected one worker bundle, received ${bundle.outputs.length}.`);
const workerBundle = bundle.outputs[0];
if (!workerBundle) throw new Error('Structure worker build produced no output artifact.');
const notices = [
  'vendor/cubiomes/LICENSE',
  'tools/licenses/wasi/LICENSE',
  'tools/licenses/wasi/LICENSE-APACHE',
  'tools/licenses/wasi/LICENSE-APACHE-LLVM',
  'tools/licenses/wasi/LICENSE-MIT',
  'tools/licenses/wasi/libc-top-half-musl-COPYRIGHT',
  'tools/licenses/wasi/libc-bottom-half-cloudlibc-LICENSE',
  'tools/licenses/wasi/dlmalloc-NOTICE',
];
const license = [
  'Third-party notices for structures.wasm and structure-worker.js.',
  'Cubiomes: https://github.com/Cubitect/cubiomes (MIT), snapshot e61f90580cbdd883214a8054670dacae655e59c0 with one fortress piece-capacity safety patch.',
  'Runtime: WASI SDK 34.0; wasi-libc 2e6fb9d8ee0cdf9e431fbcabe8af3115de000a13; compiler builtins Apache-2.0 WITH LLVM-exception.',
  'Sources and SHA256 provenance: vendor/cubiomes/provenance.json and tools/licenses/wasi/provenance.json.',
  '',
  ...await Promise.all(notices.map(async name => `===== ${name} =====\n\n${await readFile(join(root, name), 'utf8')}`)),
].join('\n') + '\n';
await Bun.write(join(output, 'structures.LICENSE.txt'), license);
await Bun.write(join(output, 'structure-worker.js'), workerBundle);
await rm(join(output, 'structures.wasm'), { force: true });
await rename(temporaryWasm, join(output, 'structures.wasm'));
console.log('Built public/structures.wasm, public/structure-worker.js and public/structures.LICENSE.txt (no threads/shared memory).');

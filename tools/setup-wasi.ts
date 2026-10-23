// Pinned upstream WASI SDK; downloads/extraction stay in ignored gt-out, never vendor.
// Source/digests: https://api.github.com/repos/WebAssembly/wasi-sdk/releases/tags/wasi-sdk-34
// Run: bun tools/setup-wasi.ts. Set WASI_SDK_PATH to use an already installed SDK.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const version = '34.0';
const digests: Record<string, string> = {
  'x86_64-windows': 'cccb5c323a9b34f0349a9b09e8804a0a7632c68c3310f4b5f437ed57d7e71d8f',
  'arm64-windows': '45e1c71f3e965621e7b98ebe1d37b0e4b1f77f3e8072113ffb4534e67b1a4b7c',
  'x86_64-linux': 'b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4',
  'arm64-linux': 'f7e243dff54d60bcc576e94d6166b69f410f2500ae4a9ceef34315be10e77971',
  'riscv64-linux': '71417f267b3a2015780b10045707eecec9fef6d064d2f79e82ad0618f9e4eac5',
  'x86_64-macos': '87d27fa8adc68dee59bfbf2e22a6d34ef717c34d6bf1d8af2a56fc929d9ce0eb',
  'arm64-macos': '9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9',
};
const projectRoot = resolve(import.meta.dir, '..');
const executableSuffix = process.platform === 'win32' ? '.exe' : '';

async function usableSDK(directory: string): Promise<boolean> {
  try {
    for (const name of [`bin/clang${executableSuffix}`, `bin/wasm-ld${executableSuffix}`,
      'share/wasi-sysroot/lib/wasm32-wasip1/libc.a', 'share/wasi-sysroot/lib/wasm32-wasip1/libm.a']) {
      if (!(await stat(join(directory, name))).isFile()) return false;
    }
    return true;
  } catch { return false; }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function setupWasi(): Promise<string> {
  if (process.env.WASI_SDK_PATH) {
    const directory = resolve(process.env.WASI_SDK_PATH);
    if (!(await usableSDK(directory))) throw new Error(`WASI_SDK_PATH lacks clang, wasm-ld, or the real WASI libc/libm: ${directory}`);
    return directory;
  }
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform;
  const platform = `${arch}-${os}`;
  const digest = digests[platform];
  if (!digest) throw new Error(`No pinned WASI SDK for ${platform}; set WASI_SDK_PATH to a compatible installation.`);
  const name = `wasi-sdk-${version}-${platform}`;
  const cache = join(projectRoot, 'gt-out');
  const directory = join(cache, name);
  const marker = join(directory, '.seeded-sdk-sha256');
  if (await usableSDK(directory) && await readFile(marker, 'utf8').catch(() => '') === digest) return directory;
  await mkdir(cache, { recursive: true });
  const archive = join(cache, `${name}.tar.gz`);
  if (await sha256(archive).catch(() => '') !== digest) {
    const url = `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/${name}.tar.gz`;
    console.log(`Downloading ${url} into gt-out (first build only).`);
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`WASI SDK download failed: HTTP ${response.status}`);
    const partial = `${archive}.partial`;
    try {
      await Bun.write(partial, response);
      const actual = await sha256(partial);
      if (actual !== digest) throw new Error(`WASI SDK SHA256 mismatch: expected ${digest}, got ${actual}`);
      await rm(archive, { force: true });
      await rename(partial, archive);
    } finally { await rm(partial, { force: true }); }
  }
  console.log(`Extracting verified ${name}.tar.gz into gt-out.`);
  const staging = `${directory}.extracting`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    // Relative archive paths also work with MSYS tar, which treats C: as a remote host.
    const extraction = Bun.spawn(['tar', '-xzf', `${name}.tar.gz`, '--strip-components=1', '-C', `${name}.extracting`],
      { cwd: cache, stdout: 'inherit', stderr: 'inherit' });
    if (await extraction.exited !== 0) throw new Error('WASI SDK extraction failed; tar must support gzip archives.');
    if (!(await usableSDK(staging))) throw new Error('Extracted WASI SDK lacks required compiler/sysroot files.');
    await writeFile(join(staging, '.seeded-sdk-sha256'), digest);
    await rm(directory, { recursive: true, force: true });
    await rename(staging, directory);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return directory;
}

if (import.meta.main) console.log(await setupWasi());

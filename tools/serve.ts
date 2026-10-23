// Local dev server: bundles src/web entries on request, serves public/ and
// locally-built bundles/. Binds to 0.0.0.0; no auth, not for public exposure.
//
// Usage: bun tools/serve.ts [--port 8787]

import { existsSync, readdirSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';

const root = resolve(import.meta.dir, '..');
const portArg = Bun.argv.indexOf('--port');
const port = portArg > 0 ? Number(Bun.argv[portArg + 1]) : 8787;
const bundlesDir = join(root, 'bundles');

const ENTRIES: Record<string, string> = {
  '/gpu-diff.js': 'src/web/gpu-diff.ts',
  '/version-diff.js': 'src/web/version-diff.ts',
  '/structure-diff.js': 'src/web/structure-diff.ts',
  '/structure26-diff.js': 'src/web/structure26-diff.ts',
};

async function bundle(entry: string): Promise<Response> {
  const out = await Bun.build({ entrypoints: [join(root, entry)], target: 'browser', format: 'esm', sourcemap: 'inline' });
  if (!out.success) return new Response(out.logs.map(String).join('\n'), { status: 500 });
  return new Response(await out.outputs[0]!.text(), { headers: { 'content-type': 'text/javascript' } });
}

function staticFile(base: string, rel: string): Response {
  const p = normalize(join(base, rel));
  if (!p.startsWith(base + sep) || !existsSync(p)) return new Response('not found', { status: 404 });
  return new Response(Bun.file(p));
}

const server = Bun.serve({
  hostname: '0.0.0.0',
  port,
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const entry = ENTRIES[path];
    if (entry) return bundle(entry);
    if (path === '/bundles/index.json') {
      const list = existsSync(bundlesDir) ? readdirSync(bundlesDir).filter((n) => n.endsWith('.bundle.json') && !n.endsWith('.structures.bundle.json')).sort() : [];
      return Response.json(list);
    }
    if (path.startsWith('/bundles/')) return staticFile(bundlesDir, path.slice('/bundles/'.length));
    if (path === '/verification/version-fixtures.json') return staticFile(join(root, 'gt-out'), 'version-fixtures.json');
    if (path === '/verification/structure-fixtures.json') return staticFile(join(root, 'gt-out'), 'structure-fixtures.json');
    if (path === '/verification/structure26-official.json') return staticFile(join(root, 'gt-out'), 'structure26-official.json');
    return staticFile(join(root, 'public'), path === '/' ? 'index.html' : path.slice(1));
  },
});
console.log(`serving on http://127.0.0.1:${server.port}`);

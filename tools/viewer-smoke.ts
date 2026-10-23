// Drives the real viewer page headlessly: waits for a render, switches
// bundle / dimension / seed via the UI controls, and saves screenshots.
//
// Usage: bun tools/viewer-smoke.ts --chrome <chrome> --url http://127.0.0.1:8787/ --out gt-out/shots

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './headless';

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i += 2) args.set(Bun.argv[i]!.replace(/^--/, ''), Bun.argv[i + 1] ?? '');
const chrome = args.get('chrome') ?? process.env.CHROME ?? '';
const url = args.get('url') ?? 'http://127.0.0.1:8787/';
const out = args.get('out') ?? 'gt-out/shots';
mkdirSync(out, { recursive: true });

const page = await launch(chrome, url);
const waitRendered = async (prev: string): Promise<string> => {
  for (let i = 0; i < 600; i++) {
    const s = await page.evaluate<string>(`document.getElementById('status').textContent`);
    if (s !== prev && /samples|rror|No /.test(s)) return s;
    await Bun.sleep(250);
  }
  throw new Error('render timed out');
};
const setAndRender = (js: string): Promise<void> => page.evaluate(`(() => { ${js}; document.getElementById('render').click(); })()`);
const legend = (): Promise<string[]> => page.evaluate(`[...document.querySelectorAll('#legend span:not(.sw)')].map(e => e.textContent)`);

try {
  const cases: [string, string][] = [
    ['26.2-overworld', `document.getElementById('dim').value = 'overworld'`],
    ['26.2-overworld-y-30', `document.getElementById('y').value = '-30'`],
    ['26.2-nether', `document.getElementById('dim').value = 'nether'; document.getElementById('y').value = '64'`],
    ['26.2-end', `document.getElementById('dim').value = 'end'; document.getElementById('zoom').value = '64'`],
  ];
  let status = await waitRendered('');
  console.log(`initial: ${status.replace(/\n/g, ' | ')}`);
  for (const [name, js] of cases) {
    await setAndRender(js);
    status = await waitRendered(status);
    writeFileSync(join(out, `${name}.png`), await page.screenshot());
    console.log(`${name}: ${status.replace(/\n/g, ' | ')}\n  legend: ${(await legend()).slice(0, 10).join(', ')}`);
  }
  // Switch bundle through the <select> to prove the version is data-driven.
  await page.evaluate(`(() => { const s = document.getElementById('bundle'); s.value = '1.21.4.bundle.json'; s.dispatchEvent(new Event('change')); })()`);
  status = await waitRendered(status);
  await setAndRender(`document.getElementById('dim').value = 'overworld'; document.getElementById('y').value = '-30'; document.getElementById('zoom').value = '16'`);
  status = await waitRendered(status);
  writeFileSync(join(out, '1.21.4-overworld-y-30.png'), await page.screenshot());
  console.log(`1.21.4-overworld-y-30: ${status.replace(/\n/g, ' | ')}\n  legend: ${(await legend()).slice(0, 10).join(', ')}`);
} finally {
  page.close();
}

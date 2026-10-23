// Exercises the real Vapor UI. Optional local bundles are not required.
// bun tools/viewer-smoke.ts --chrome <chrome> --url http://127.0.0.1:8787/
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, type Headless } from "./headless";

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i += 2)
  args.set(Bun.argv[i]!.replace(/^--/, ""), Bun.argv[i + 1] ?? "");
const chrome = args.get("chrome") ?? process.env.CHROME ?? "";
const url = args.get("url") ?? "http://127.0.0.1:8787/";
const out = args.get("out") ?? "gt-out/shots";
mkdirSync(out, { recursive: true });

async function ready(page: Headless): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const state = await page.evaluate<{ error?: string; ready: boolean }>(
      `({error: document.querySelector('.map-error')?.textContent, ready: !!document.querySelector('#map.has-frame') && document.querySelector('.map-surface')?.getAttribute('aria-busy') === 'false'})`,
    );
    if (state.error) throw new Error(state.error);
    if (state.ready) return;
    await Bun.sleep(250);
  }
  throw new Error("Map render timed out");
}
async function record(page: Headless, name: string): Promise<void> {
  await ready(page);
  const state = await page.evaluate<{
    context: string;
    status: string;
    overflow: boolean;
  }>(
    `({context: document.querySelector('.map-context').textContent, status: document.querySelector('.map-footer').textContent, overflow: document.documentElement.scrollWidth > innerWidth})`,
  );
  console.log(name, state);
  if (state.overflow) throw new Error(`${name}: horizontal page overflow`);
  writeFileSync(join(out, `${name}.png`), await page.screenshot());
}
const desktop = await launch(chrome, url);
try {
  await record(desktop, "desktop-overworld");
  for (const [index, name] of [
    [2, "nether"],
    [3, "end"],
    [1, "overworld"],
  ] as const) {
    await desktop.evaluate(
      `document.querySelector('.dimension-options button:nth-child(${index})').click()`,
    );
    await record(desktop, `desktop-${name}`);
  }
  await desktop.evaluate(
    `(() => { const s = document.querySelector('#version'); s.value = '1.7.10'; s.dispatchEvent(new Event('change',{bubbles:true})); const seed = document.querySelector('#seed'); seed.value = '-1'; seed.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.primary-button').click(); })()`,
  );
  await record(desktop, "desktop-1.7.10");
  await desktop.evaluate(
    `document.querySelector('.panel-tabs button:nth-child(2)').click()`,
  );
  await desktop.evaluate(
    `(() => { const layer = [...document.querySelectorAll('.layer-option')].find(e => /Village/.test(e.textContent)); if (!layer) throw new Error('Village layer missing'); layer.querySelector('input').click(); })()`,
  );
  await ready(desktop);
  const count = await desktop.evaluate<number>(
    `document.querySelectorAll('.map-marker').length`,
  );
  if (count === 0)
    throw new Error("Expected village candidates in the default viewport");
  await desktop.evaluate(`document.querySelector('.map-marker').click()`);
  await record(desktop, "desktop-structures");
} finally {
  desktop.close();
}

const mobile = await launch(chrome, url, undefined, {
  width: 375,
  height: 812,
});
try {
  await record(mobile, "mobile-map");
  await mobile.evaluate(`document.querySelector('.mobile-nav button').click()`);
  if (
    !(await mobile.evaluate<boolean>(
      `document.querySelector('.sidebar').classList.contains('is-open') && document.querySelector('.map-main').inert`,
    ))
  )
    throw new Error("Mobile settings drawer did not isolate the map");
  writeFileSync(join(out, "mobile-settings.png"), await mobile.screenshot());
  await mobile.evaluate(`document.querySelector('.close-panel').click()`);
  if (
    !(await mobile.evaluate<boolean>(
      `document.querySelector('.sidebar').inert`,
    ))
  )
    throw new Error("Closed mobile drawer remains keyboard-accessible");
} finally {
  mobile.close();
}

// Minimal Chrome DevTools Protocol driver for headless WebGPU runs.
// Uses SwiftShader's software Vulkan when no hardware adapter is available.
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Headless {
  evaluate<T>(expression: string): Promise<T>;
  /** PNG bytes of the current viewport. */
  screenshot(): Promise<Uint8Array>;
  close(): void;
}

interface CdpReply {
  id?: number;
  method?: string;
  params?: { args?: { value?: unknown; description?: string }[] };
  result?: { data?: string; result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
}

export const DEFAULT_GPU_FLAGS = [
  '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
];

export async function launch(chrome: string, url: string, flags = DEFAULT_GPU_FLAGS, viewport = { width: 1280, height: 800 }): Promise<Headless> {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), 'webgpu-cubiomes-chrome-'));
  const proc = Bun.spawn([chrome, '--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, ...flags, 'about:blank'], { stdout: 'ignore', stderr: 'pipe' });
  const stderr = new Response(proc.stderr).text();
  const cleanup = (): void => { void proc.exited.then(() => rm(profile, { recursive: true, force: true, maxRetries: 5 })).catch(console.error); };
  let wsUrl = '';
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await Bun.sleep(100);
    if (proc.exitCode !== null) break;
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()) as { type: string; webSocketDebuggerUrl: string }[];
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? '';
    } catch { /* not up yet */ }
  }
  if (!wsUrl) { proc.kill(); cleanup(); throw new Error(`Chrome did not expose a page target: ${await stderr}`); }

  const ws = new WebSocket(wsUrl);
  const opened = Promise.withResolvers<void>();
  const openDeadline = setTimeout(() => opened.reject(new Error('Chrome CDP WebSocket open timed out')), 10000);
  ws.onopen = () => opened.resolve();
  ws.onerror = () => opened.reject(new Error('Chrome CDP WebSocket connection failed'));
  try { await opened.promise; }
  catch (error) { ws.close(); proc.kill(); cleanup(); throw error; }
  finally { clearTimeout(openDeadline); }
  let id = 0;
  const pending = new Map<number, (v: CdpReply) => void>();
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data)) as CdpReply;
    if (d.method === 'Runtime.consoleAPICalled') console.error('[page]', (d.params?.args ?? []).map((a) => a.value ?? a.description).join(' '));
    if (d.id !== undefined) { pending.get(d.id)?.(d); pending.delete(d.id); }
  };
  const send = (method: string, params: object = {}): Promise<CdpReply> => {
    const { promise, resolve } = Promise.withResolvers<CdpReply>();
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
    return promise;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await Bun.sleep(1000);
  return {
    async evaluate<T>(expression: string): Promise<T> {
      const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 600000 });
      const ex = res.result?.exceptionDetails;
      if (ex) throw new Error(ex.exception?.description ?? ex.text ?? 'evaluation failed');
      return res.result?.result?.value as T;
    },
    async screenshot(): Promise<Uint8Array> {
      const res = await send('Page.captureScreenshot', { format: 'png' });
      return Uint8Array.from(atob(res.result?.data ?? ''), (c) => c.charCodeAt(0));
    },
    close(): void {
      ws.close();
      proc.kill();
      cleanup();
    },
  };
}

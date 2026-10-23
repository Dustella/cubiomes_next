// Dedicated-worker entry. No structure calculation runs on the caller's thread.
import { StructureEngine } from './engine';
import { BundleStructureEngine } from './bundle-engine';
import type { StructureWorkerMessage, StructureWorkerReply } from './protocol';

let engine: StructureEngine | undefined;
let bundleEngine: BundleStructureEngine | undefined;
let initializing = false;

async function dispatch(message: StructureWorkerMessage): Promise<void> {
  try {
    if (message.kind === 'initialize') {
      if (engine || bundleEngine || initializing) throw new Error('Structure worker is already initialized');
      initializing = true;
      let input: ArrayBuffer | WebAssembly.Module;
      if (typeof message.wasm === 'string') {
        const response = await fetch(message.wasm);
        if (!response.ok) throw new Error(`Loading structure WASM failed: HTTP ${response.status}`);
        input = await response.arrayBuffer();
      } else {
        input = message.wasm;
      }
      const created = await StructureEngine.create(input);
      try {
        created.setWorld(message.world.mc, message.world.seed, message.world.largeBiomes);
      } catch (error) {
        created.destroy();
        throw error;
      }
      engine = created;
      postMessage({ id: message.id, ok: true, kind: 'initialized' } satisfies StructureWorkerReply);
    } else if (message.kind === 'initializeBundle') {
      if (engine || bundleEngine || initializing) throw new Error('Structure worker is already initialized');
      initializing = true;
      let data: unknown = message.bundle;
      if (typeof message.bundle === 'string') {
        const response = await fetch(message.bundle);
        if (!response.ok) throw new Error(`Loading structure bundle failed: HTTP ${response.status}`);
        data = await response.json();
      }
      const created = await BundleStructureEngine.create(data, message.world.seed, message.world.dimension, message.world.preset);
      bundleEngine = created;
      postMessage({ id: message.id, ok: true, kind: 'bundleInitialized', version: created.version } satisfies StructureWorkerReply);
    } else if (message.kind === 'execute') {
      if (!engine) throw new Error('Structure worker is not initialized');
      const result = engine.execute(message.request);
      postMessage({ id: message.id, ok: true, kind: 'result', result } satisfies StructureWorkerReply);
    } else if (message.kind === 'executeBundle') {
      if (!bundleEngine) throw new Error('Structure bundle worker is not initialized');
      const result = bundleEngine.execute(message.request);
      postMessage({ id: message.id, ok: true, kind: 'bundleResult', result } satisfies StructureWorkerReply);
    } else {
      throw new TypeError('Unknown structure worker message');
    }
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    const fatal = error instanceof WebAssembly.RuntimeError;
    if (fatal) { engine = undefined; bundleEngine = undefined; }
    postMessage({ id: message.id, ok: false, name: e.name, message: e.message, fatal } satisfies StructureWorkerReply);
  } finally {
    if (message.kind === 'initialize' || message.kind === 'initializeBundle') initializing = false;
  }
}

globalThis.onmessage = (event: MessageEvent<StructureWorkerMessage>) => {
  void dispatch(event.data);
};

import { validateBundle } from '../core/bundle';
import { DimensionModel } from '../core/generator';
import { GpuBiomeRunner } from '../gpu/runner';
import { GpuVersionBiomeRunner } from '../library';
import { validateRegion, validateSeed } from '../inputs';
import { SUPPORTED_VERSIONS, resolveVersion } from '../versions';
import { STRUCTURES } from '../structures/catalog';
import { StructureWorker } from '../structures/client';
import { BundleStructureWorker } from '../structures/bundle-client';
import type { StructureConfig } from '../structures/types';
import type { BundleCatalogResponse } from '../structures/bundle-schema';
import { cubiomesNames, type ViewWorld, type ViewRegion, type ViewLayer, type ViewMarker, type ViewFrame, type ViewVersion, type ViewBounds, type ViewerCpuReply } from './viewer-types';
export type { ViewWorld, ViewRegion, ViewLayer, ViewMarker, ViewFrame, ViewVersion, ViewBounds } from './viewer-types';

type Runner = GpuVersionBiomeRunner | GpuBiomeRunner;
type Bounds = ViewBounds;
type Scan = { regionX: number; regionZ: number; width: number; height: number; clipped: boolean };
const COLORS = ['#eabf68', '#87d5c5', '#e496a6', '#9db9f3', '#c6a1e5', '#a9cf7c', '#e79b69'];
const LIMIT = 30_000_000;
const MARKER_LIMIT = 2048;
const label = (id: string): string => id.replace(/^minecraft:/, '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
function checkBounds(b: Bounds): Bounds {
  const v = [b.minX, b.minZ, b.maxX, b.maxZ];
  if (!v.every(Number.isSafeInteger) || b.maxX <= b.minX || b.maxZ <= b.minZ) throw new RangeError('Marker bounds must be a non-empty integer block rectangle');
  const clamp = (n: number): number => Math.max(-LIMIT, Math.min(LIMIT, n));
  return { minX: clamp(b.minX), minZ: clamp(b.minZ), maxX: clamp(b.maxX), maxZ: clamp(b.maxZ) };
}
function inside(b: Bounds, x: number, z: number): boolean {
  return x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ;
}
/** Scan whole placement regions nearest the viewport centre, never an unbounded
 * chunk sweep. Only complete regions inside the structure API border are sent. */
function scanBounds(b: Bounds, span: number, budget: number): Scan | null {
  const lo = Math.ceil(-LIMIT / span), hi = Math.floor((LIMIT + 1) / span) - 1;
  let x0 = Math.max(lo, Math.floor(b.minX / span)), z0 = Math.max(lo, Math.floor(b.minZ / span));
  const x1 = Math.min(hi, Math.floor((b.maxX - 1) / span)), z1 = Math.min(hi, Math.floor((b.maxZ - 1) / span));
  if (x0 > x1 || z0 > z1) return null;
  const originalW = x1 - x0 + 1, originalH = z1 - z0 + 1;
  let width = originalW, height = originalH;
  if (width * height > budget) {
    const scale = Math.sqrt(budget / (width * height));
    width = Math.max(1, Math.min(width, Math.floor(width * scale), budget));
    height = Math.max(1, Math.min(height, Math.floor(budget / width)));
    x0 += Math.floor((originalW - width) / 2);
    z0 += Math.floor((originalH - height) / 2);
  }
  return { regionX: x0, regionZ: z0, width, height, clipped: width !== originalW || height !== originalH || b.minX < -LIMIT || b.minZ < -LIMIT || b.maxX > LIMIT || b.maxZ > LIMIT };
}

/** Two independent serial lanes: biome sampling (GPU / CPU worker) and
 * structure queries (WASM / bundle workers). A slow structure scan never
 * delays biome tiles, and vice versa. Each lane tracks its own world.
 * destroy() terminates workers immediately but retires GPU resources only
 * after the biome lane settles (idle-only destruction contract). */
export class ViewerRuntime {
  private biomeQueue: Promise<unknown> = Promise.resolve();
  private structureQueue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private biomeWorldKey = '';
  private structureWorldKey = '';
  private biomeKey = '';
  private versionList?: Promise<ViewVersion[]>;
  private readonly localBundles = new Map<string, string>();
  private device?: GPUDevice;
  private runner?: Runner;
  private gpuNames: string[] = [];
  private gpuFailure = '';
  private deviceLost = false;
  private cpu?: Worker;
  private cpuId = 0;
  private cpuPending?: { id: number; resolve: (reply: Extract<ViewerCpuReply, { ok: true }>) => void; reject: (error: Error) => void };
  private structures?: StructureWorker;
  private bundleStructures?: BundleStructureWorker;
  private configs: StructureConfig[] = [];
  private bundleCatalog?: BundleCatalogResponse;
  private layerList?: ViewLayer[];
  private readonly rings = new Map<string, ViewMarker[]>();

  private assertOpen(): void {
    if (this.closed) throw new Error('Viewer runtime has been destroyed');
  }
  private enqueue<T>(lane: 'biome' | 'structure', operation: () => Promise<T>): Promise<T> {
    const previous = lane === 'biome' ? this.biomeQueue : this.structureQueue;
    const result = previous.then(async () => {
      this.assertOpen();
      const value = await operation();
      this.assertOpen();
      return value;
    });
    const settled = result.catch(() => {});
    if (lane === 'biome') this.biomeQueue = settled;
    else this.structureQueue = settled;
    return result;
  }

  versions(): Promise<ViewVersion[]> {
    this.assertOpen();
    this.versionList ??= (async () => {
      try {
        const response = await fetch('/bundles/index.json');
        if (response.ok) {
          const files: unknown = await response.json();
          if (Array.isArray(files)) for (const version of ['1.21.4', '26.2']) {
            const file = `${version}.bundle.json`;
            if (files.includes(file)) this.localBundles.set(version, `/bundles/${encodeURIComponent(file)}`);
          }
        }
      } catch { /* Optional local data is not needed on a clean clone. */ }
      const builtIn = [...SUPPORTED_VERSIONS].reverse().map(v => ({ id: v.id, label: v.id }));
      const local = ['26.2', '1.21.4'].filter(v => this.localBundles.has(v)).map(id => ({ id, label: `${id} · local bundle` }));
      return [...local, ...builtIn];
    })();
    return this.versionList.then(list => list.map(v => ({ ...v })));
  }

  private stopCpu(): void {
    this.cpu?.terminate();
    this.cpu = undefined;
    this.cpuPending?.reject(new Error('Biome CPU worker terminated'));
    this.cpuPending = undefined;
  }
  private releaseGpu(): void {
    this.runner?.destroy();
    this.runner = undefined;
    this.gpuNames = [];
  }
  private async checkWorld(world: ViewWorld): Promise<string> {
    validateSeed(world.seed);
    if (!['overworld', 'nether', 'end'].includes(world.dimension)) throw new RangeError('Unknown dimension');
    if (!Number.isFinite(world.y)) throw new RangeError('Y must be finite');
    await this.versions();
    this.assertOpen();
    if (!this.localBundles.has(world.version)) resolveVersion(world.version);
    return `${world.version}/${world.dimension}/${world.seed}`;
  }
  private async useBiomeWorld(world: ViewWorld): Promise<void> {
    const key = await this.checkWorld(world);
    if (key === this.biomeWorldKey && !this.deviceLost) return;
    const biomeKey = `${world.version}/${world.dimension}`;
    if (biomeKey !== this.biomeKey || this.deviceLost) this.releaseGpu();
    else this.runner?.setSeed(world.seed);
    this.biomeKey = biomeKey;
    this.gpuFailure = '';
    if (this.deviceLost) { this.device = undefined; this.deviceLost = false; }
    this.biomeWorldKey = key;
  }
  private async useStructureWorld(world: ViewWorld): Promise<void> {
    const key = await this.checkWorld(world);
    if (key === this.structureWorldKey) return;
    this.structures?.terminate();
    this.bundleStructures?.terminate();
    this.structures = undefined;
    this.bundleStructures = undefined;
    this.configs = [];
    this.bundleCatalog = undefined;
    this.layerList = undefined;
    this.rings.clear();
    this.structureWorldKey = key;
  }

  private async getDevice(): Promise<GPUDevice> {
    if (this.deviceLost) throw new Error('WebGPU device was lost');
    if (this.device) return this.device;
    if (!navigator.gpu) throw new Error('WebGPU is unavailable');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter is available');
    const device = await adapter.requestDevice();
    this.device = device;
    void device.lost.then(info => {
      if (this.device !== device || this.closed) return;
      this.deviceLost = true;
      this.gpuFailure = `WebGPU device lost: ${info.message}`;
    });
    return device;
  }
  private async getRunner(world: ViewWorld): Promise<Runner> {
    if (this.runner) return this.runner;
    const device = await this.getDevice();
    const bundleURL = this.localBundles.get(world.version);
    if (bundleURL) {
      const response = await fetch(bundleURL);
      if (!response.ok) throw new Error(`Loading local biome bundle failed: HTTP ${response.status}`);
      const bundle = validateBundle(await response.json());
      if (bundle.version !== world.version) throw new Error('Local bundle version does not match the selected world');
      const model = DimensionModel.fromBundle(bundle, world.dimension);
      const runner = await GpuBiomeRunner.create(device, model);
      this.runner = runner;
      this.gpuNames = model.biomes;
      runner.setSeed(world.seed);
    } else {
      const runner = await GpuVersionBiomeRunner.create(device, world);
      this.runner = runner;
      this.gpuNames = cubiomesNames(runner.version.mc);
    }
    return this.runner;
  }

  private cpuFrame(world: ViewWorld, region: ViewRegion): Promise<Extract<ViewerCpuReply, { ok: true }>> {
    this.assertOpen();
    if (!this.cpu) {
      const worker = new Worker(new URL('./viewer-worker.ts', import.meta.url), { type: 'module', name: 'biome-cpu-fallback' });
      this.cpu = worker;
      worker.onmessage = (event: MessageEvent<ViewerCpuReply>) => {
        const reply = event.data, pending = this.cpuPending;
        if (!pending || pending.id !== reply.id) return;
        this.cpuPending = undefined;
        if (reply.ok) pending.resolve(reply);
        else pending.reject(new Error(reply.message));
      };
      worker.onerror = event => {
        this.cpuPending?.reject(new Error(event.message || 'Biome CPU worker failed to load'));
        this.cpuPending = undefined;
        worker.terminate();
        if (this.cpu === worker) this.cpu = undefined;
      };
      worker.onmessageerror = () => this.stopCpu();
    }
    const { promise, resolve, reject } = Promise.withResolvers<Extract<ViewerCpuReply, { ok: true }>>();
    const id = ++this.cpuId;
    this.cpuPending = { id, resolve, reject };
    try { this.cpu!.postMessage({ id, world, region, bundleURL: this.localBundles.get(world.version) }); }
    catch (error) { this.cpuPending = undefined; reject(error); }
    return promise;
  }

  frame(world: ViewWorld, region: ViewRegion): Promise<ViewFrame> {
    world = { ...world }; region = { ...region };
    return this.enqueue('biome', async () => {
      validateRegion({ ...region, qy: Math.floor(world.y / 4) });
      await this.useBiomeWorld(world);
      if (!this.gpuFailure) {
        try {
          const runner = await this.getRunner(world);
          this.assertOpen();
          const result = await runner.run({ ...region, qy: Math.floor(world.y / 4) });
          return { biomes: result.biomes, names: this.gpuNames, gpuMs: result.gpuMs, backend: 'WebGPU' };
        } catch (error) {
          this.gpuFailure = error instanceof Error ? error.message : String(error);
          this.releaseGpu();
        }
      }
      this.releaseGpu();
      const result = await this.cpuFrame(world, region);
      return { biomes: result.biomes, names: result.names, gpuMs: null, backend: `CPU worker · ${this.gpuFailure}` };
    });
  }

  private async getLayers(world: ViewWorld): Promise<ViewLayer[]> {
    if (this.layerList) return this.layerList;
    if (world.version === '26.2') {
      const worker = await BundleStructureWorker.create(world, { bundle: '/bundles/26.2.structures.bundle.json' });
      if (this.closed) { worker.terminate(); this.assertOpen(); }
      this.bundleStructures = worker;
      const catalog = await worker.execute({ op: 'catalog' });
      this.bundleCatalog = catalog;
      this.layerList = catalog.sets.filter(set => set.activeStructures.length > 0).map((set, index) => ({
        id: set.id, label: label(set.id), color: COLORS[index % COLORS.length]!,
        detail: set.placement.type === 'concentric_rings'
          ? 'Preferred-biome-adjusted ring candidates; first 16 positions only. Not confirmed generation.'
          : 'Structure-set placement candidates: frequency and exclusion checked; biome, terrain and generation starts not checked.',
      }));
    } else {
      const worker = await StructureWorker.create(world);
      if (this.closed) { worker.terminate(); this.assertOpen(); }
      this.structures = worker;
      const catalog = await worker.execute({ op: 'catalog' });
      const dimension = world.dimension === 'nether' ? -1 : world.dimension === 'end' ? 1 : 0;
      this.configs = catalog.structures.filter(c => c.supported && c.dimension === dimension && c.regionSize !== null && c.regionSize > 0);
      this.layerList = this.configs.map((config, index) => {
        const descriptor = STRUCTURES.find(s => s.id === config.type)!;
        return {
          id: descriptor.kind, label: label(descriptor.kind), color: COLORS[index % COLORS.length]!,
          detail: config.biomeSupported
            ? 'Biome-viable placement candidates; terrain, pieces and full generation are not confirmed.'
            : 'Placement-only candidates: biome viability is unsupported; no generation claim.',
        };
      });
      if (world.dimension === 'overworld') this.layerList.push({ id: 'stronghold', label: 'Strongholds', color: '#cfb9ff', detail: 'Cubiomes biome-adjusted ring candidates; not confirmed generation.' });
    }
    return this.layerList;
  }

  layers(world: ViewWorld): Promise<ViewLayer[]> {
    world = { ...world };
    return this.enqueue('structure', async () => { await this.useStructureWorld(world); return (await this.getLayers(world)).map(l => ({ ...l })); });
  }

  /** Structure candidates inside half-open block bounds. Bounds are clamped to
   * the structure API border; dense layers scan only central regions. */
  markers(world: ViewWorld, area: ViewBounds, layerIds: string[]): Promise<ViewMarker[]> {
    world = { ...world }; layerIds = [...new Set(layerIds)];
    const b = checkBounds(area);
    return this.enqueue('structure', async () => {
      await this.useStructureWorld(world);
      const layers = (await this.getLayers(world)).filter(l => layerIds.includes(l.id));
      const markers: ViewMarker[] = [];
      const budget = Math.min(256, Math.max(1, Math.floor(4096 / Math.max(1, layers.length))));
      for (const layer of layers) {
        if (this.bundleStructures) await this.bundleMarkers(layer, b, budget, markers);
        else await this.oldMarkers(layer, b, budget, markers);
      }
      if (markers.length > MARKER_LIMIT) {
        return markers.slice(0, MARKER_LIMIT).map(m => ({ ...m, detail: `${m.detail} Display clipped to ${MARKER_LIMIT} markers.` }));
      }
      return markers;
    });
  }

  private async oldMarkers(layer: ViewLayer, b: Bounds, budget: number, out: ViewMarker[]): Promise<void> {
    const worker = this.structures!;
    if (layer.id === 'stronghold') {
      let markers = this.rings.get(layer.id);
      if (!markers) {
        const result = await worker.execute({ op: 'strongholds' });
        markers = result.records.map(record => ({ id: `stronghold:${record.index}`, layer: layer.id, label: 'Stronghold candidate', x: record.position.x, z: record.position.z, detail: `${layer.detail} Ring ${record.ring + 1}, index ${record.index + 1} of ${result.total}.` }));
        this.rings.set(layer.id, markers);
      }
      out.push(...markers.filter(m => inside(b, m.x, m.z)));
      return;
    }
    const descriptor = STRUCTURES.find(s => s.kind === layer.id)!;
    const config = this.configs.find(c => c.type === descriptor.id)!;
    const scan = scanBounds(b, config.regionSize! * 16, budget);
    if (!scan) return;
    const result = await worker.execute({ op: 'scan', type: config.type, regionX: scan.regionX, regionZ: scan.regionZ, width: scan.width, height: scan.height, stage: config.biomeSupported ? 'biome' : 'placement' });
    for (const record of result.records) {
      if (record.accepted === false || !inside(b, record.position.x, record.position.z)) continue;
      const checked = record.biome?.supported && record.biome.viable === true;
      out.push({ id: `${layer.id}:${record.regionX}:${record.regionZ}`, layer: layer.id, label: `${layer.label} candidate`, x: record.position.x, z: record.position.z,
        detail: `${checked ? 'Biome-viable placement candidate; terrain and full generation not confirmed.' : 'Placement-only candidate; biome viability not established; no generation claim.'}${scan.clipped ? ` Scan clipped to ${scan.width} × ${scan.height} central placement regions.` : ''}` });
    }
  }

  private async bundleMarkers(layer: ViewLayer, b: Bounds, budget: number, out: ViewMarker[]): Promise<void> {
    const worker = this.bundleStructures!;
    const set = this.bundleCatalog!.sets.find(s => s.id === layer.id)!;
    if (set.placement.type === 'concentric_rings') {
      let markers = this.rings.get(layer.id);
      if (!markers) {
        const count = Math.min(16, set.placement.count);
        const result = await worker.execute({ op: 'rings', set: set.id, count });
        markers = result.positions.map((p, index) => ({ id: `${set.id}:${index}`, layer: layer.id, label: `${layer.label} candidate`, x: p.locateX, z: p.locateZ, detail: `Preferred-biome-adjusted ring candidate; not confirmed generation.${result.total > count ? ` Scan clipped to the first ${count} of ${result.total} ring positions.` : ''}` }));
        this.rings.set(layer.id, markers);
      }
      out.push(...markers.filter(m => inside(b, m.x, m.z)));
      return;
    }
    const scan = scanBounds(b, set.placement.spacing * 16, budget);
    if (!scan) return;
    const result = await worker.execute({ op: 'scan', set: set.id, regionX: scan.regionX, regionZ: scan.regionZ, width: scan.width, height: scan.height });
    const active = new Set(set.activeStructures.map(s => s.structure));
    for (const candidate of result.candidates) {
      if (!candidate.placementPass || !inside(b, candidate.locateX, candidate.locateZ)) continue;
      const attempts = candidate.attemptOrder.filter(id => active.has(id)).map(label);
      out.push({ id: `${set.id}:${candidate.regionX}:${candidate.regionZ}`, layer: layer.id, label: `${layer.label} candidate`, x: candidate.locateX, z: candidate.locateZ,
        detail: `Placement candidate; frequency and exclusion passed. Dimension-eligible attempt order (not a final selection): ${attempts.join(' → ')}. Biome eligibility, terrain and generation starts are not checked.${scan.clipped ? ` Scan clipped to ${scan.width} × ${scan.height} central placement regions.` : ''}` });
    }
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopCpu();
    this.structures?.terminate();
    this.bundleStructures?.terminate();
    void this.biomeQueue.finally(() => {
      this.releaseGpu();
      this.device?.destroy();
      this.device = undefined;
    });
  }
}

// CPU fallback is deliberately a dedicated worker, including bundle parsing,
// model compilation and generator construction, not just the sampling loop.
import { validateBundle } from '../core/bundle';
import { BiomeGenerator, DimensionModel } from '../core/generator';
import { CpuBiomeGenerator } from '../library';
import { validateRegion, validateSeed } from '../inputs';
import { cubiomesNames, type ViewerCpuReply, type ViewerCpuRequest } from './viewer-types';

// DOM and worker globals share this project's type environment. Keep transfer
// semantics explicit instead of resolving Window.postMessage's targetOrigin.
const scope = globalThis as unknown as {
  postMessage(message: ViewerCpuReply, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ViewerCpuRequest>) => void) | null;
};

let key = '';
let generator: CpuBiomeGenerator | BiomeGenerator | undefined;
let names: string[] = [];
let queue = Promise.resolve();

async function dispatch(request: ViewerCpuRequest): Promise<void> {
  try {
    const { world, region } = request;
    validateSeed(world.seed);
    const r = { ...region, qy: Math.floor(world.y / 4) };
    validateRegion(r);
    const nextKey = `${world.version}/${world.dimension}/${world.seed}/${request.bundleURL ?? ''}`;
    if (key !== nextKey || !generator) {
      if (request.bundleURL) {
        const response = await fetch(request.bundleURL);
        if (!response.ok) throw new Error(`Loading local biome bundle failed: HTTP ${response.status}`);
        const bundle = validateBundle(await response.json());
        if (bundle.version !== world.version) throw new Error('Local bundle version does not match the selected world');
        const model = DimensionModel.fromBundle(bundle, world.dimension);
        generator = new BiomeGenerator(model, world.seed);
        names = model.biomes;
      } else {
        generator = new CpuBiomeGenerator(world);
        names = cubiomesNames(generator.version.mc);
      }
      key = nextKey;
    }
    let biomes: Uint32Array;
    if (generator instanceof CpuBiomeGenerator) biomes = generator.run(r);
    else {
      biomes = new Uint32Array(r.w * r.h);
      for (let z = 0; z < r.h; z++) {
        for (let x = 0; x < r.w; x++) biomes[z * r.w + x] = generator.biome(r.x0 + x * r.step, r.qy, r.z0 + z * r.step);
      }
    }
    scope.postMessage({ id: request.id, ok: true, biomes, names }, [biomes.buffer]);
  } catch (error) {
    scope.postMessage({ id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
}

scope.onmessage = (event: MessageEvent<ViewerCpuRequest>) => {
  queue = queue.then(() => dispatch(event.data));
};

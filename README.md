# Cubiomes Next

Clean-room Minecraft biome and structure calculations, with WebGPU biome compute and a dedicated WASM structure worker.

- **Cubiomes release library:** all release majors from 1.0 through **1.21.3**, across Overworld / Nether / End; no game jars or bundles required.
- **Bundle path:** data-driven 1.18+ generation, datapacks and Amplified in the library; the atlas additionally discovers locally generated normal-world 1.21.4 / 26.2 bundles.
- **Structure library:** all 25 Cubiomes structure/decorator types plus strongholds and related layout/gateway APIs, from 1.0 through **1.21.4 inclusive**, running off-thread in WASM.
- **26.2 structure-set experiment:** separate data-bundle worker for verified candidates, placement rules, adjusted stronghold rings and explicit-point biome eligibility; not complete terrain-dependent structure generation. See [scope and evidence](docs/26.2-structures.md).
- **Seed atlas:** Vue **3.6.0-rc.13**, pure Vapor components / `createVaporApp`, **Vite 8.3.5** and UnoCSS **66.11.0**. Responsive Minecraft-inspired controls, biome maps and worker-backed structure overlays.

## Run the atlas

```sh
git clone https://github.com/Dustella/cubiomes_next.git
cd cubiomes_next
bun install --frozen-lockfile
bun run dev                 # http://localhost:8787
```

No Java, official game files or extracted bundles are needed for the default **1.21.3** world or the other 24 built-in release entries. The checked-in `public/structure-worker.js`, `structures.wasm` and notices make structure overlays work immediately. WebGPU needs HTTPS or localhost; if unavailable or a compute run fails, the atlas explicitly displays **CPU worker** and performs sampling in a dedicated worker rather than blocking the UI. This viewer fallback does not change the GPU library's strict API.

- Enter a numeric/text seed, version, center X/Z and sampling Y, then **生成地图**. Dimension buttons apply the current settings immediately.
- Drag or use arrow keys to pan; wheel, `+`/`-`, toolbar buttons, or two-finger pinch to zoom. **⌖** returns to the origin.
- **结构图层** toggles version/dimension-appropriate candidates. Click a marker for coordinates and the exact scope of its checks; copy coordinates from the card.
- **群系** lists sampled biome coverage at the selected height. The reference grid is a screen-space aid, **not a chunk grid**.
- Share copies a URL containing the normalized seed, applied world settings, center, zoom and selected layers. Export saves the biome sample PNG **without structure markers**.
- On phones, bottom navigation opens a scrollable sheet; Escape/close dismisses it. Closed controls are inert; open sheets isolate background interaction and trap keyboard focus. Safe-area insets and reduced-motion preferences are respected.
- Seeds are computed locally. There is no seed-upload endpoint, analytics or external asset/font service.

Structure scan limits are deliberate and disclosed: at most 256 central placement regions per layer, 4,096 across the selected layers, and 2,048 displayed markers. Empty areas outside a clipped scan do **not** prove absence. Cubiomes strongholds use the full available list; the 26.2 overlay currently queries only the first **16** adjusted ring positions, explicitly labeled. 26.2 markers confirm placement/frequency/exclusion, not generation starts, terrain or pieces.

```sh
bun run typecheck
bun test
bun run build               # self-contained static dist/, no official-derived bundles
bun run preview             # preview production build at localhost:8787
```

Deploy `dist/` at the origin root over HTTPS. Keep `structure-worker.js`, `structures.wasm` and `structures.LICENSE.txt` together. `dist/bundles/index.json` intentionally contains `[]`: builds never redistribute locally extracted game data implicitly. Development servers bind to all interfaces; use only on a trusted network.


## Bundle-based 1.18+ path

cubiomes stops at 1.21 Winter Drop (`MC_NEWEST = MC_1_21_WD`) and hard-codes its biome tree (`tables/btree21wd.h`), climate noise parameters and splines. 26.x already differs. 26.2 adds `minecraft:sulfur_caves` to the overworld parameter list and new noises such as `nether/temperature` and `sulfur_cave_gradient`.

Since 1.18 the game itself declares almost all of this in data:

| Piece | Source in the official server jar |
| --- | --- |
| Noise parameters | `data/minecraft/worldgen/noise/*.json` |
| Climate density functions (incl. depth/offset spline) | `data/minecraft/worldgen/density_function/**`, `noise_settings/*.json` → `noise_router` |
| Biome decision table (7594 boxes for 26.2) | datagen report `reports/biome_parameters/minecraft/{overworld,nether}.json` |

The decision "tree" is not stored as a tree; it is a flat list of parameter boxes. The game builds an R-tree from it at runtime. We rebuild the same structure from the JSON (`src/core/climate.ts`), because the game breaks equal-distance ties by tree visit order.

## Cubiomes release library: strictly below 1.21.4

Import the TypeScript library from `src/index.ts` (also the package export). Runtime dependencies: none for CPU; a supplied `GPUDevice` for GPU. Use Bun or a TypeScript-aware bundler.

```ts
import { CpuBiomeGenerator, GpuVersionBiomeRunner, SUPPORTED_VERSIONS } from './src';

const options = {
  version: '1.16.5',
  dimension: 'overworld' as const, // 'overworld' | 'nether' | 'end'
  seed: -123456789n,              // signed 64-bit bigint, not a JS number
  largeBiomes: false,
};
const region = { x0: -128, z0: -128, w: 256, h: 256, step: 1, qy: 16 };

const cpu = new CpuBiomeGenerator(options);
const id = cpu.biome(0, 16, 0);
const exactIds = cpu.run(region);

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error('WebGPU adapter unavailable');
const device = await adapter.requestDevice();
const gpu = await GpuVersionBiomeRunner.create(device, options);
try {
  const { biomes, gpuMs } = await gpu.run(region);
  gpu.setSeed(12345n); // uploads seed-derived state, not a CPU biome map
  const next = await gpu.run(region);
} finally {
  gpu.destroy();    // releases runner resources, does not destroy your device
  device.destroy();
}
console.log(SUPPORTED_VERSIONS.map(v => v.id));
```

### Version and coordinate contract

- Exact release entries: `1.0.0`, `1.1.0`, `1.2.5`, `1.3.2`, `1.4.7`, `1.5.2`, `1.6.4`, `1.7.10`, `1.8.9`, `1.9.4`, `1.10.2`, `1.11.2`, `1.12.2`, `1.13.2`, `1.14.4`, `1.15.2`, `1.16.1`, `1.16.5`, `1.17.1`, `1.18.2`, `1.19.2`, `1.19.4`, `1.20.6`, `1.21.1`, `1.21.3`.
- Major aliases select the last listed patch of that major: `1.16` → `1.16.5`, `1.19` → `1.19.4`, **`1.21` → `1.21.3`**, never 1.21.4. Other patch strings, beta versions, and versions outside this range are rejected, not guessed.
- All positions, `step`, and `qy` are **quart coordinates** (one unit = four blocks). `qy: 16` means block Y=64. Negative positions use the same floor/truncation rules as Cubiomes.
- IDs are **Cubiomes numeric biome IDs**, not palette indices. `Uint32Array` output is row-major: `biomes[z * w + x]` samples `(x0 + x * step, qy, z0 + z * step)`.
- Coordinates must be integers whose block conversion fits signed i32. `w`, `h`, and `step` must be positive integers; GPU buffer/dispatch limits are checked. Oversized requests fail explicitly; callers can tile them.
- Large Biomes is Overworld-only, introduced in 1.3. Amplified is not a Cubiomes release-library preset; the separate bundle path retains its existing support.
- This is the native quart biome grid, **not block-resolution Voronoi zoom**. Pre-1.18 Overworld and standard Nether/End previews ignore Y, matching Cubiomes. Pre-1.16 Nether is biome 8; pre-1.9 End is biome 9.
- GPU runners allow one in-flight run. Await it before `setSeed`, another `run`, or `destroy`. Destruction is idempotent; later use is rejected. Separate runners can share a device.
- The Vapor atlas exposes all built-in release entries and three dimensions; optional local bundles are described below. Advanced Large Biomes/datapack/preset options remain library APIs.

### Algorithms and accuracy

`src/legacy` implements versioned layer generation with exact 64-bit integer RNG on CPU/GPU. Independently bounded dependency branches avoid merging differently scaled river/land requests into enormous rectangles at far coordinates. `src/modern` uses the Cubiomes climate noise/spline configuration and the original climate-tree traversal, including fanout-ten 1.18/1.19.2 tables and later fanout-six tables. 1.20.6/1.21.1/1.21.3 legitimately share Cubiomes' `btree20`; the pale-garden tree starts at excluded 1.21.4.

`src/dimensions` implements Cubiomes Nether float-distance ties and End island thresholds, including the changed far-coordinate overflow behavior after 1.13. All GPU paths compute biomes on-device; CPU work seeds RNG/permutations and prepares metadata.

CPU follows Cubiomes' double/float staging. GPU uses f32 climate interpolation and compensated arithmetic for legacy ocean/Nether noise, so **zero mismatches in the verification matrix is not a proof of bit-identical output at every boundary**. Use `CpuBiomeGenerator` for exact Cubiomes queries; no silent CPU fallback is substituted for GPU computation.

### Release verification

Observed on Nvidia/Lovelace hardware: **485 cases, 80,704 samples, 25 release entries; zero CPU mismatches, zero GPU biome mismatches, zero GPU errors**, against a separately compiled, unmodified Cubiomes oracle. Includes normal/Large Biomes, seeds 0/-1/12345 and signed-long extrema, five heights, negative positions, and coordinates near ±7,000,000 quarts.

| Dimension | Cases | Samples | CPU mismatches | Hardware GPU mismatches |
| --- | ---: | ---: | ---: | ---: |
| Overworld, normal + Large Biomes | 235 | 39,104 | 0 | 0 |
| Nether | 125 | 20,800 | 0 | 0 |
| End | 125 | 20,800 | 0 | 0 |

Reproduce from this directory, with GCC and the sibling MIT Cubiomes checkout:

```sh
bun install
bun -e "require('node:fs').mkdirSync('gt-out', { recursive: true })"
# Windows uses .exe; omit that extension on other platforms.
gcc -O2 -fwrapv -I../cubiomes-viewer/cubiomes tools/version-oracle.c ../cubiomes-viewer/cubiomes/generator.c ../cubiomes-viewer/cubiomes/layers.c ../cubiomes-viewer/cubiomes/biomenoise.c ../cubiomes-viewer/cubiomes/noise.c ../cubiomes-viewer/cubiomes/biomes.c -lm -o gt-out/version-oracle.exe
bun run release-fixtures
bun run check-releases
bun run typecheck
bun test
bun run serve:verification
```

Native results/fixtures are local ignored artifacts, not runtime library assets. Open `/version-diff.html` on the WebGPU-capable browser, then run:

```js
await window.releaseVerification.initialize();
await window.releaseVerification.runCases(0, 50); // continue in bounded batches to 485
window.releaseVerification.reports;              // includes errors and mismatch examples
window.releaseVerification.release();
```

Regenerate checked-in implementation data, without any official jars: `bun tools/export-modern.ts` reads MIT Cubiomes tables/splines; `bun tools/export-legacy.ts` generates WGSL from the shared typed layer rules. Re-run the oracle comparisons after changing either source.

Additional hardware smoke covered seed changes, input snapshots across awaits, in-flight operation rejection, idempotent destruction, and rejection after destruction. The existing 1.21.4/26.2 bundle paths were also exercised in all three dimensions: no biome differences against their CPU reference; existing ±1-quantum climate differences remain.

### Change record

- Added the standalone release API, version catalog, three dimension backends, and native/hardware differential harnesses.
- Corrected climate-tree fanout handling and far-coordinate Large Biomes dependency planning during oracle verification; version-boundary and far-coordinate regressions are in `test/versions.test.ts`.

## Structure library: through 1.21.4 inclusive

Import from `src/structures/index.ts`, the package's `/structures` export, or the root entry. `StructureWorker` runs the vendored MIT Cubiomes implementation with real WASI libc/libm. All generation, biome checks, terrain sampling, recursive layouts, result decoding, and default WASM fetching/compilation happen in a dedicated worker. There is no main-thread CPU fallback or structure GPU path, and no SharedArrayBuffer/COOP/COEP requirement.

The structure version catalog is `STRUCTURE_VERSIONS`: the earlier 25 entries plus `1.21.4`. **`resolveStructureVersion('1.21')` selects 1.21.4**; the existing biome library's `resolveVersion('1.21')` intentionally remains 1.21.3. Structure checks use Cubiomes' own 1.21.4 biome generator internally, not an alias to the earlier JS biome model.

26.2 uses the separate `BundleStructureWorker` API and a locally generated structure bundle. Its 20 sets/34 definitions, placement rules, weighted retry ordering, adjusted rings and explicit-point biome eligibility were compared with the official runtime; complete 26.2 starts/terrain/piece layouts are **not** advertised. See [the investigation, usage and evidence](docs/26.2-structures.md). The APIs below remain the Cubiomes-facing 1.0–1.21.4 API.

### Usage and deployment

Deploy these checked-in distribution assets together:

- `public/structure-worker.js`
- `public/structures.wasm`
- `public/structures.LICENSE.txt`

The default worker URL is `/structure-worker.js`; WASM defaults to `structures.wasm` beside that worker. Use a same-origin worker URL; set the runtime options for a different asset directory. No compiler, game jar, external Cubiomes checkout, or SDK is needed at runtime.

```ts
import { StructureWorker, resolveStructure } from './src/structures';

const structures = await StructureWorker.create(
  { version: '1.21.4', seed: -123456789n, largeBiomes: false },
  // Optional: defaults work with the bundled development server.
  { workerURL: '/structure-worker.js', wasm: '/structures.wasm' },
);
try {
  const village = resolveStructure('village');
  const result = await structures.execute({
    op: 'scan', type: village.id,
    regionX: -4, regionZ: -4, width: 8, height: 8,
    stage: 'biome', includeRejected: true,
  });
  // result.records: block positions plus supported/viable/accepted statuses.
  const rings = await structures.execute({ op: 'strongholds', offset: 0, count: 128 });
  const capabilities = await structures.execute({ op: 'catalog' });
} finally {
  structures.terminate();
}
```

One immutable world/seed per worker. Requests may be queued concurrently and execute serially. Create separate workers for parallel worlds. `terminate()` rejects all pending callers and releases worker/WASM memory; it also cancels a busy world when the user changes seeds. Recoverable input/resource errors reject their own request without poisoning later queries; a fatal WASM fault terminates the client.

For Bun, pass `workerURL: new URL('./public/structure-worker.js', import.meta.url)` and `wasm: new Uint8Array(await Bun.file('public/structures.wasm').arrayBuffer())`. Supplied bytes are copied before transfer, so the caller's buffer is not detached. An already compiled `WebAssembly.Module` is also accepted. The default browser path compiles inside the worker.

### Structures and operations

`STRUCTURES` exposes stable Cubiomes numeric IDs and canonical names. Supported availability is determined per version by `getStructureConfig()`, not inferred from names:

| Dimension | Canonical structure/decorator names |
| --- | --- |
| Overworld | `feature`, `desert_pyramid`, `jungle_temple`, `swamp_hut`, `igloo`, `village`, `ocean_ruin`, `shipwreck`, `monument`, `mansion`, `outpost`, `ruined_portal`, `ancient_city`, `buried_treasure`, `mineshaft`, `desert_well`, `geode`, `trail_ruins`, `trial_chambers` |
| Nether | `ruined_portal_nether`, `fortress`, `bastion` |
| End | `end_city`, `end_gateway`, `end_island` |

`feature` is Cubiomes' shared pre-1.13 placement-attempt grid, not an additional building. Strongholds use their own ring algorithm rather than a structure-region ID.

`execute()` has discriminated request/response types; its result is inferred from `op`:

| Operation | Calculation |
| --- | --- |
| `catalog` | All 25 versioned configurations and biome/terrain/variant capabilities |
| `position` | Placement attempt for one structure region; failed attempts are `null` |
| `scan` | Bounded rectangular placement/biome/terrain scan, optionally including rejected/unknown candidates |
| `check` | Biome and optional terrain check at an arbitrary block position; **does not establish placement** |
| `featureBiome` | Cubiomes' structure-specific biome predicate |
| `variant` | Supported start piece, rotation, flags, offsets and size fields; village/portal queries require an explicit biome ID |
| `strongholds` | Accurate Cubiomes positions, zero-based pagination, ring and next approximate position; 3 before 1.9, 128 from 1.9 |
| `pieces` | Full End City or Fortress construction-piece list with names, bounding boxes and orientation |
| `endIslands` | Up to two small-island candidates, radii/heights, and the separate biome eligibility result |
| `fixedGateways` | All 20 inner gateway positions in generation order |
| `linkedGateway` | Outer gateway search position, destination chunk, and destination block position |
| `villageHouses` | Nine old village house counts and exact RNG state; only before 1.14, not a complete village layout |
| `endChunkEmpty` | Cubiomes' End empty-chunk test including supported small-island decoration |

### Coordinate and result contract

- These are **not biome-library quart coordinates**. Positions and `check`/`variant`/gateway `x,z` are blocks. `chunkX,chunkZ` are 16-block chunks. `regionX,regionZ,width,height` address structure regions; multiply a configuration's `regionSize` by 16 to get its block spacing. Decorators, treasure and mineshafts have one-chunk regions.
- `StructureConfig.dimension` preserves Cubiomes values: Overworld 0, Nether -1, End 1. `rarity` is also raw Cubiomes metadata: old decorators can use an integer RNG denominator greater than one, not a probability.
- `stage: 'placement'` only tests the attempt RNG. `'biome'` additionally tests biome/exclusion rules. `'terrain'` additionally applies the available Cubiomes terrain filter. `accepted: true` is **relative to that stage**, never a promise of actual Minecraft generation.
- Unsupported checks are `{ supported: false, raw: null, viable: null }`, not false/true guesses. `accepted: null` means a requested check is unavailable. Without `includeRejected`, scans return only `accepted === true`; use the catalog and `includeRejected: true` to distinguish unknown from rejected.
- Raw biome-check return values are retained; Cubiomes sometimes returns a biome ID rather than 1. Do not require `raw === 1` to interpret success.
- Terrain modes: `approximate` is the 1.18+ Overworld temple/mansion height proxy; `end-surface` is the End City surface check; `not-required` means **no additional terrain test in Cubiomes**, not proof of vanilla terrain; `unsupported` explicitly has no such calculation. Nether scans normally use the biome stage.
- Variant output preserves upstream sentinels, including unknown height fields. Only names listed in `knownFields` are meaningful for that variant/version. Offsets are raw Cubiomes offsets, not universally absolute world coordinates.
- Piece lists are Cubiomes construction geometry: horizontal block positions, End City vertical origin 0, Fortress vertical origin 64. They are not final terrain-adjusted world Y coordinates or generated blocks.
- Bounds are explicit: at most 16,384 regions per scan, 16,384 requested pieces, 16 MiB serialized result, block coordinates within ±30,000,000, and complete queried region bounds within that range. Chunk bounds leave room for a full 16×16 chunk. Tile larger queries. Linked gateway sources must be nonzero with squared radius at most signed-i32 maximum, avoiding an upstream integer-overflow hazard.
- Piece queries return a complete layout or fail with `RangeError`; they never silently return a capacity-truncated structure. Returned objects own their data and remain valid after the next request.

### Baseline limitations

Support follows Cubiomes, not every historical feature's actual introduction date. Desert wells, scattered End gateways, and small End island decoration are supported only from 1.13 in this snapshot; fixed inner gateways and End City geometry start at 1.9. Older unsupported requests report support status explicitly.

Cubiomes cannot determine complete Overworld surface terrain, ruined portals' cave/height-dependent failures or duplicates, or every structure's full piece layout. This API does not invent those answers. Ancient City/Trial Chamber variants and biome checks are supported, but full piece lists exist only for Fortress/End City. Spawn and slime chunks are outside this structure API.

### Structure verification and rebuilding

Observed **3,658 cases across 26 versions, all 25 type IDs and all 13 operations**: zero differences/errors in both real Bun workers and the attached Chromium dedicated workers versus a separately compiled native oracle. Coverage includes version/configuration transitions, negative coordinates, signed-long extrema, normal/Large Biomes, accepted/rejected attempts, complete 128-stronghold rings, recursive layouts, Pale Garden predicates, and one/two-island positive witnesses at each End decoration RNG boundary.

The original, untouched sibling Cubiomes oracle and capacity-guarded vendor oracle produced **byte-identical fixture artifacts**. This verifies that the safety patch does not alter the tested complete results. Separate tests exercise capacity failure, recovery, unsupported checks, request errors, worker termination and pending-caller rejection. The full suite, including authored 26.2 bundle behavior regressions, currently passes 36 tests.

The browser also processed a 16,384-region Trial Chamber biome scan while the main thread continued processing MessageChannel tasks. This is off-thread execution evidence, not a general throughput guarantee. Local reports: `gt-out/structure-worker-report.json` and `gt-out/structure-browser-report.json`.

```sh
bun install
# Only needed to regenerate the already checked-in distribution assets:
bun run setup:wasi       # pinned SDK 34.0 + SHA256, cache under ignored gt-out/
bun run build:structures
# Needs a native C compiler, default gcc; CC may override it:
bun run structure-fixtures
bun run check:structures
bun run typecheck
bun test
bun run serve:verification
```

Open `/structure-diff.html` in a real browser, call `await window.structureVerification.initialize()`, then `runCases(start,end)` in bounded batches through 3658; inspect `reports` and call `release()` afterwards.

Vendored Cubiomes provenance and source hashes are in `vendor/cubiomes/provenance.json`, snapshot `e61f90580cbdd883214a8054670dacae655e59c0`. One local MIT-source safety patch checks Fortress piece capacity before writes: upstream sets `nmax` but never reads it. Normal complete layouts are unchanged; saturation now enables bounded growth or a clean failure. The generated deployable notice retains this patch attribution plus Cubiomes and linked WASI libc/compiler-runtime licenses. No official game source or assets enter these sources or binaries.

### Structure change record

- Added inclusive-1.21.4 structure versions, the typed worker API, all baseline structure operations, vendored clean MIT sources, and reproducible/distributable WASM assets.
- Added native/browser/worker differential harnesses and consumer-visible boundary regressions.
- Corrected upstream Fortress capacity enforcement; tested failure followed by complete layout recovery.
- Added the separately verified 26.2 data-bundle experiment and shared worker transport without changing the numeric Cubiomes version resolver. Official-derived data remains local and ignored.

## Layout

```
src/index.ts   release-library entry: CpuBiomeGenerator / GpuVersionBiomeRunner
src/legacy/    Cubiomes 1.0–1.17 Overworld layers, shared integer rules and WGSL
src/modern/    Cubiomes 1.18–1.21.3 climate model and licensed generated tables
src/dimensions/ versioned standard Nether and End, CPU + WebGPU
src/structures/ typed asynchronous worker client, WASI adapter, operation/result types
wasm/          bounded C bridge over the vendored Cubiomes implementation
vendor/cubiomes/ MIT source snapshot, source hashes, and recorded capacity safety patch
public/        deployable worker/WASM/license assets and browser verification pages
src/core/      CPU reference (f64): RNG, MD5 seeding, noise, density-function compiler/evaluator, climate R-tree, End islands
src/gpu/       WGSL codegen from the same IR + WebGPU runner
src/web/       pure Vapor atlas, viewer runtime / CPU worker, browser differential entries
tools/         bundle builders, GT harnesses, headless driver, separate verification server
test/          unit tests (no Mojang data needed)
```

## Optional local bundle versions

```sh
# Build locally from your own official input; outputs remain gitignored:
bun tools/make-bundle.ts --server path/to/server.jar --out bundles/26.2.bundle.json
# The same command with a 1.21.4 jar and bundles/1.21.4.bundle.json adds 1.21.4.
# For 26.2 structure layers, also generate the separate structure registry bundle:
bun run bundle:structures --data path/to/generated/data/minecraft --biomes bundles/26.2.bundle.json --out bundles/26.2.structures.bundle.json
bun run dev
```

Vite discovers exactly `bundles/1.21.4.bundle.json` and `bundles/26.2.bundle.json`, labeled **local bundle** in the version menu; structure bundles are excluded from the biome-only index. A missing/broken structure bundle reports a layer-specific error without preventing the biome map from rendering. Other versions, arbitrary bundle file upload, datapacks and non-normal presets remain accessible through the library/builder rather than the atlas UI. Bundle schema: `src/core/bundle.ts`; 26.2 structure setup: [docs/26.2-structures.md](docs/26.2-structures.md).

Unsupported density-function types fail with the JSON path of the offending node rather than rendering wrong output.

## Legal / repo hygiene

- Bundles, GT dumps (`gt-out/`), server jars and anything extracted from them are gitignored and must not be committed. `bundles/` is built locally from the user's own jar.
- The implementation does not copy game method bodies. Bundle inputs are public JSON data and vanilla datagen reports; ground truth comes from tools calling official APIs. The 26.2 investigation additionally inspected local implementation behavior outside the project, as permitted; raw inspection output is not tracked.
- The Cubiomes-only release phases use the local MIT implementation and existing clean-room code. Cubiomes-derived code/tables retain attribution under `LICENSE.cubiomes`; they are not extracted Mojang assets. The separate 26.2 path follows the source/data boundaries documented in `docs/26.2-structures.md`.
- Structure distribution additionally links WASI libc/compiler builtins. Preserve `public/structures.LICENSE.txt`; source notices/provenance are under `tools/licenses/wasi/`. These notices are separate from the Cubiomes MIT license.
- A few behaviours are code rather than data. Each is isolated, documented at the definition, and verified by GT:
  - Legacy-random-source noise seeding: `DEFAULT_LEGACY_NOISE_OVERRIDES` in `src/core/evaluate.ts`, overridable per bundle.
  - The End biome thresholds: `src/core/end.ts`.
  - The R-tree construction and search order.

## Verification

### CPU reference vs ground truth

`bun tools/gt-diff.ts` compares quantised climate vectors and biome ids per sample.

| Oracle | Version | Presets | Samples | Climate mismatches | Biome mismatches |
| --- | --- | --- | --- | --- | --- |
| official jar (unobfuscated, public API) | 26.2 | overworld, large_biomes, amplified (y = 16/-12/-60), nether, end | 3 seeds × 9216 each, plus far coordinates (±7,000,000) | 0 | 0 |
| cubiomes (jar is obfuscated) | 1.21.4 | overworld, large_biomes | 3 seeds × 2 depths × 9216 | depth ±1 on ≤4 samples/run (cubiomes float spline) | 0 |
| cubiomes | 1.21.4 | nether | 3 seeds × 9216 | n/a | 1–3 per run, all at exact equal-distance ties where cubiomes uses float distances |

```sh
bun tools/gt-diff.ts --server-dir ../official_source/26.2 --bundle bundles/26.2.bundle.json --preset overworld --seed 12345
bun tools/gt-diff.ts --oracle cubiomes --cubiomes ../cubiomes-viewer/cubiomes --bundle bundles/1.21.4.bundle.json --preset overworld
```

(`--server-dir` is a directory where the server jar has been run once, so `versions/` and `libraries/` exist.)

### GPU vs CPU reference

`bun tools/gpu-diff.ts --chrome <chrome>` runs the generated shader in headless Chrome. It falls back to SwiftShader (software Vulkan) when no hardware adapter is available.

| Dimension | Samples | Biome mismatches | Climate mismatches |
| --- | --- | --- | --- |
| overworld / large_biomes / amplified | 9 × 16384 | 1 (0.0007%) | 0.1–0.6% of values off by exactly 1 quantum |
| nether | 3 × 16384 | 0 | ≤0.25% off by 1 |
| end (incl. ±7,000,000) | 5 × 9216–16384 | 0 | n/a |

How f32 stays this close without f64:

- Noise coordinates are carried as (exact `i32` cell, `f32` fraction). The power-of-two octave scales, the second sampler's 337/331 stretch, and the per-octave lattice offsets are applied in integer arithmetic.
- The End's simplex skew uses 48-bit fixed point. The island-size term emulates Java's float rounding exactly with 64-bit integer pairs. The game's int-overflow NaN far out is reproduced explicitly.
- Climate-tree distances are exact 64-bit integers, so ties resolve like the CPU.

Residual error lives in f32 octave sums and splines. It shows up only as ±1-quantum climate values and very rare biome flips on exact parameter boundaries. Exact results are always available from the CPU path (`BiomeGenerator`).

### Viewer

`bun tools/viewer-smoke.ts --chrome <chrome> --url http://127.0.0.1:8787/` exercises the actual Vapor UI: all three dimensions, an older release and seed change, village overlays/details, mobile layout and drawer isolation. It saves screenshots to ignored `gt-out/shots/`. The historical bundle-viewer measurements above predate this frontend.

The standalone differential pages remain on the separate `bun run serve:verification` server; stop Vite first or choose a different `--port`. They are diagnostic tools, not routes in the production atlas.

Current atlas smoke evidence:

| Surface | Exercised result |
| --- | --- |
| Attached Nvidia WebGPU | Built-in 1.21.3 and local 26.2 maps; real worker village candidates and clickable detail cards |
| Responsive layouts | 375, 768, 1280, 1440 and 1920 px; no horizontal page overflow |
| Headless UI command | All three dimensions, 1.7.10 / seed -1, 9 village markers, mobile sheet open/close and inert background checks passed |
| Production build | 25 built-in versions, working biome maps and 11 village markers; no local official bundles required |
| Worker fallback | Explicitly disabled WebGPU: CPU-worker map rendered; backend is identified in the UI, with its full reason in the badge tooltip |
| Seed changes | Shader runner retained across seeds; 4,082 changed samples, zero mismatches against the CPU reference in a 64×64 probe |

Seed-only changes upload new seed state rather than recompiling the GPU pipeline. The headless driver now uses an OS-native temporary profile path and reports CDP connection failures instead of hanging; generated profiles are removed after exit.

Unit tests: `bun test`.

## Known limits / next steps

- Hardware release-library verification is recorded above. The older bundle-path measurements under "GPU vs CPU reference" remain historical SwiftShader results; they are not Nvidia performance benchmarks.
- The game's per-thread "last result" cache affects which biome wins an exact tie. The GT harness emulates it (sequential order). Any parallel generator, including the game's own multithreaded chunk generation, can legitimately differ at those points.
- Structures and strongholds through 1.21.4 are available through the WASM worker API above. Spawn remains unported; structure prediction retains the documented Cubiomes terrain/layout limitations.
- Inline noise definitions inside density functions (allowed by datapacks) are rejected with a clear error. Vanilla does not use them for climate.

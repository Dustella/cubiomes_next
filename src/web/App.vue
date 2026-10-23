<script setup lang="ts" vapor>
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { parseSeed } from "../core/rng";
import { biomeColor } from "./colors";
import {
  ViewerRuntime,
  type ViewWorld,
  type ViewRegion,
  type ViewFrame,
  type ViewMarker,
  type ViewLayer,
  type ViewVersion,
} from "./viewer-runtime";

const runtime = new ViewerRuntime();
const versions = ref<ViewVersion[]>([]);
const version = ref("1.21.3");
const dimension = ref<ViewWorld["dimension"]>("overworld");
const seed = ref("12345");
const height = ref(64);
const cx = ref(0),
  cz = ref(0),
  zoom = ref(16);
const world = shallowRef<ViewWorld | null>(null);
const tab = ref("world"),
  panelOpen = ref(false);
const canvas = ref<HTMLCanvasElement>(),
  surface = ref<HTMLDivElement>();
const frame = shallowRef<
  (ViewFrame & { region: ViewRegion; world: ViewWorld }) | null
>(null);
const layers = ref<ViewLayer[]>([]),
  selectedLayers = ref<string[]>([]);
const markers = shallowRef<ViewMarker[]>([]),
  selectedMarker = shallowRef<ViewMarker | null>(null);
const busy = ref(false),
  error = ref(""),
  status = ref("正在准备地图引擎…");
const backend = ref("初始化"),
  elapsed = ref(0),
  grid = ref(false);
const hover = ref<{ x: number; z: number; name: string } | null>(null);
const legend = ref<{ name: string; color: string; percent: string }[]>([]);
const notice = ref("");
const layerError = ref("");
const shareLink = (): void => {
  void copy(location.href);
};
const dragOffset = ref({ x: 0, y: 0 });
const dimensions = [
  { id: "overworld", name: "主世界", glyph: "▰" },
  { id: "nether", name: "下界", glyph: "♨" },
  { id: "end", name: "末地", glyph: "✧" },
] as const;
const dimensionName = computed(
  () => dimensions.find((d) => d.id === dimension.value)?.name ?? "主世界",
);
const zooms = [4, 8, 16, 32, 64, 128];
const displaySeed = computed(() => world.value?.seed.toString() ?? seed.value);
const layerById = computed(
  () => new Map(layers.value.map((layer) => [layer.id, layer])),
);
const visibleMarkers = computed(() => {
  const r = frame.value?.region;
  if (!r) return [];
  return markers.value
    .map((marker) => ({
      ...marker,
      left: ((marker.x / 4 - r.x0) / (r.w * r.step)) * 100,
      top: ((marker.z / 4 - r.z0) / (r.h * r.step)) * 100,
    }))
    .filter(
      (marker) =>
        marker.left >= 0 &&
        marker.left <= 100 &&
        marker.top >= 0 &&
        marker.top <= 100,
    );
});
const blocksPerPixel = computed(() =>
  frame.value && surface.value
    ? (frame.value.region.w * frame.value.region.step * 4) /
      surface.value.clientWidth
    : zoom.value / 2,
);
const scale = computed(() => {
  const wanted = blocksPerPixel.value * 110;
  const power = 10 ** Math.floor(Math.log10(Math.max(1, wanted)));
  const blocks =
    [5, 2, 1].map((n) => n * power).find((n) => n <= wanted) ?? power;
  return { blocks, pixels: blocks / blocksPerPixel.value };
});
const friendly = (name: string): string =>
  name
    .replace(/^minecraft:/, "")
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
const color = (name: string): string =>
  "#" + biomeColor(name).toString(16).padStart(6, "0");
let request = 0,
  handled = 0,
  running = false,
  disposed = false,
  toastTimer = 0,
  resizeTimer = 0;
let layerKey = "";
let resizeObserver: ResizeObserver | undefined;

function toast(message: string): void {
  notice.value = message;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    notice.value = "";
  }, 2800);
}
function makeRegion(): ViewRegion {
  const width = surface.value?.clientWidth ?? 640,
    h = surface.value?.clientHeight ?? 640;
  const factor = Math.max(2, width / 448, h / 384);
  const w = Math.max(16, Math.floor(width / factor)),
    rows = Math.max(16, Math.floor(h / factor));
  const step = zoom.value / 4;
  return {
    x0: Math.floor(cx.value / 4 - (w * step) / 2),
    z0: Math.floor(cz.value / 4 - (rows * step) / 2),
    w,
    h: rows,
    step,
  };
}
function paint(result: ViewFrame, region: ViewRegion): void {
  const target = canvas.value;
  if (!target) return;
  target.width = region.w;
  target.height = region.h;
  const context = target.getContext("2d")!;
  const image = context.createImageData(region.w, region.h);
  const palette = result.names.map((name) => biomeColor(name));
  const counts = new Map<number, number>();
  for (let i = 0; i < result.biomes.length; i++) {
    const id = result.biomes[i]!,
      rgb = palette[id] ?? 0x3c4540;
    image.data[i * 4] = rgb >>> 16;
    image.data[i * 4 + 1] = (rgb >>> 8) & 255;
    image.data[i * 4 + 2] = rgb & 255;
    image.data[i * 4 + 3] = 255;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  context.putImageData(image, 0, 0);
  legend.value = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({
      name: result.names[id] ?? `Biome ${id}`,
      color: color(result.names[id] ?? String(id)),
      percent: ((count / result.biomes.length) * 100).toFixed(1),
    }));
}
function updateURL(): void {
  const params = new URLSearchParams({
    seed: world.value!.seed.toString(),
    version: version.value,
    dim: dimension.value,
    x: String(cx.value),
    z: String(cz.value),
    y: String(height.value),
    zoom: String(zoom.value),
  });
  history.replaceState(null, "", `${location.pathname}?${params}`);
}
async function render(): Promise<void> {
  request++;
  if (running || !world.value || disposed) return;
  running = true;
  busy.value = true;
  try {
    while (handled < request && !disposed) {
      const seq = request,
        activeWorld = world.value!,
        region = makeRegion();
      handled = seq;
      error.value = "";
      status.value = "正在计算群系…";
      const started = performance.now();
      try {
        const result = await runtime.frame(activeWorld, region);
        if (seq !== request) continue;
        paint(result, region);
        frame.value = { ...result, region, world: activeWorld };
        backend.value = result.backend;
        status.value = "正在计算结构图层…";
        const key = `${activeWorld.version}/${activeWorld.dimension}/${activeWorld.seed}`;
        if (key !== layerKey) {
          layerError.value = "";
          try {
            const nextLayers = await runtime.layers(activeWorld);
            if (seq !== request) continue;
            layers.value = nextLayers;
            selectedLayers.value = selectedLayers.value.filter((id) =>
              nextLayers.some((layer) => layer.id === id),
            );
            layerKey = key;
          } catch (reason) {
            if (seq !== request) continue;
            layers.value = [];
            selectedLayers.value = [];
            layerError.value = `结构图层不可用：${reason instanceof Error ? reason.message : String(reason)}`;
          }
        }
        const nextMarkers = selectedLayers.value.length
          ? await runtime.markers(activeWorld, region, [
              ...selectedLayers.value,
            ])
          : [];
        if (seq !== request) continue;
        markers.value = nextMarkers;
        elapsed.value = performance.now() - started;
        status.value = `${region.w} × ${region.h} 群系采样 · ${elapsed.value.toFixed(0)} ms`;
        updateURL();
      } catch (reason) {
        if (seq !== request) continue;
        error.value = reason instanceof Error ? reason.message : String(reason);
        status.value = "计算未完成";
      }
    }
  } finally {
    running = false;
    busy.value = false;
  }
}
function applyWorld(close = true): void {
  try {
    if (
      !Number.isInteger(height.value) ||
      height.value < -2048 ||
      height.value > 2048
    )
      throw new RangeError("Y 必须是 -2048 到 2048 之间的整数");
    if (
      ![cx.value, cz.value].every(
        (n) => Number.isInteger(n) && Math.abs(n) <= 29_000_000,
      )
    )
      throw new RangeError("中心坐标必须是 ±29,000,000 内的整数");
    const next = {
      version: version.value,
      dimension: dimension.value,
      seed: parseSeed(seed.value),
      y: height.value,
    };
    if (
      !world.value ||
      next.version !== world.value.version ||
      next.dimension !== world.value.dimension ||
      next.seed !== world.value.seed ||
      next.y !== world.value.y
    ) {
      frame.value = null;
      markers.value = [];
      selectedMarker.value = null;
      hover.value = null;
    }
    world.value = next;
    if (close) panelOpen.value = false;
    void render();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
}
function randomSeed(): void {
  const data = crypto.getRandomValues(new BigUint64Array(1));
  seed.value = BigInt.asIntN(64, data[0]!).toString();
  applyWorld();
}
function setZoom(direction: number): void {
  const index = zooms.indexOf(zoom.value),
    next = zooms[Math.max(0, Math.min(zooms.length - 1, index + direction))]!;
  if (next === zoom.value) return;
  zoom.value = next;
  void render();
}
function origin(): void {
  cx.value = 0;
  cz.value = 0;
  selectedMarker.value = null;
  void render();
}
function toggleLayer(id: string): void {
  selectedLayers.value = selectedLayers.value.includes(id)
    ? selectedLayers.value.filter((item) => item !== id)
    : [...selectedLayers.value, id];
  selectedMarker.value = null;
  void render();
}
function openTab(next: string): void {
  tab.value = next;
  panelOpen.value = true;
}
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
  } catch {
    toast("无法访问剪贴板，请从地址栏或坐标栏手动复制");
  }
}
function exportImage(): void {
  if (!canvas.value || !frame.value || busy.value) return;
  const link = document.createElement("a");
  link.download = `cubiomes-${frame.value.world.version}-${frame.value.world.seed}.png`;
  link.href = canvas.value.toDataURL("image/png");
  link.click();
  toast("已导出群系采样图（不含结构图层）");
}
const pointers = new Map<number, { x: number; y: number }>();
let drag: { x: number; y: number; cx: number; cz: number; k: number } | null =
  null;
let pinch: { distance: number; zoom: number } | null = null;
let wheelTimer = 0;
function pointerDown(event: PointerEvent): void {
  if (
    (event.target as HTMLElement).closest("button") ||
    !frame.value ||
    event.button > 0
  )
    return;
  surface.value!.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 1)
    drag = {
      x: event.clientX,
      y: event.clientY,
      cx: cx.value,
      cz: cz.value,
      k: blocksPerPixel.value,
    };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = {
      distance: Math.hypot(a!.x - b!.x, a!.y - b!.y),
      zoom: zoom.value,
    };
    drag = null;
    dragOffset.value = { x: 0, y: 0 };
  }
}
function pointerMove(event: PointerEvent): void {
  if (pointers.has(event.pointerId))
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const ratio = Math.hypot(a!.x - b!.x, a!.y - b!.y) / pinch.distance;
    const wanted = pinch.zoom / ratio;
    zoom.value = zooms.reduce(
      (best, n) =>
        Math.abs(Math.log(n / wanted)) < Math.abs(Math.log(best / wanted))
          ? n
          : best,
      zooms[0]!,
    );
    return;
  }
  if (drag) {
    dragOffset.value = { x: event.clientX - drag.x, y: event.clientY - drag.y };
    return;
  }
  if (!frame.value || !surface.value) return;
  const rect = surface.value.getBoundingClientRect(),
    r = frame.value.region;
  const px = Math.floor(((event.clientX - rect.left) / rect.width) * r.w),
    pz = Math.floor(((event.clientY - rect.top) / rect.height) * r.h);
  const id = frame.value.biomes[pz * r.w + px];
  if (id !== undefined)
    hover.value = {
      x: (r.x0 + px * r.step) * 4,
      z: (r.z0 + pz * r.step) * 4,
      name: friendly(frame.value.names[id] ?? "Unknown"),
    };
}
function pointerUp(event: PointerEvent): void {
  const cancelled = event.type === "pointercancel";
  pointers.delete(event.pointerId);
  if (pinch) {
    if (pointers.size === 0) {
      pinch = null;
      void render();
    }
    return;
  }
  if (!drag) return;
  if (!cancelled) {
    cx.value = Math.max(
      -29_000_000,
      Math.min(
        29_000_000,
        Math.round(drag.cx - (event.clientX - drag.x) * drag.k),
      ),
    );
    cz.value = Math.max(
      -29_000_000,
      Math.min(
        29_000_000,
        Math.round(drag.cz - (event.clientY - drag.y) * drag.k),
      ),
    );
  }
  drag = null;
  dragOffset.value = { x: 0, y: 0 };
  void render();
}
function wheel(event: WheelEvent): void {
  event.preventDefault();
  clearTimeout(wheelTimer);
  wheelTimer = window.setTimeout(() => setZoom(event.deltaY > 0 ? 1 : -1), 100);
}
function keyboard(event: KeyboardEvent): void {
  const movements: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const delta = movements[event.key];
  if (delta) {
    event.preventDefault();
    cx.value = Math.round(
      Math.max(
        -29_000_000,
        Math.min(29_000_000, cx.value + delta[0] * blocksPerPixel.value * 100),
      ),
    );
    cz.value = Math.round(
      Math.max(
        -29_000_000,
        Math.min(29_000_000, cz.value + delta[1] * blocksPerPixel.value * 100),
      ),
    );
    void render();
  } else if (event.key === "+" || event.key === "=") setZoom(-1);
  else if (event.key === "-") setZoom(1);
  else if (event.key === "Escape") selectedMarker.value = null;
}
onMounted(async () => {
  try {
    versions.value = await runtime.versions();
    const params = new URLSearchParams(location.search);
    if (versions.value.some((v) => v.id === params.get("version")))
      version.value = params.get("version")!;
    if (dimensions.some((d) => d.id === params.get("dim")))
      dimension.value = params.get("dim") as ViewWorld["dimension"];
    seed.value = params.get("seed") ?? "12345";
    for (const [key, target] of [
      ["x", cx],
      ["z", cz],
      ["y", height],
    ] as const) {
      const raw = params.get(key);
      if (raw !== null && Number.isFinite(Number(raw)))
        target.value = Number(raw);
    }
    if (zooms.includes(Number(params.get("zoom"))))
      zoom.value = Number(params.get("zoom"));
    applyWorld(false);
    resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => void render(), 180);
    });
    if (surface.value) resizeObserver.observe(surface.value);
  } catch (reason) {
    error.value = String(reason);
  }
});
onUnmounted(() => {
  disposed = true;
  runtime.destroy();
  resizeObserver?.disconnect();
  clearTimeout(toastTimer);
  clearTimeout(resizeTimer);
  clearTimeout(wheelTimer);
});
</script>

<template>
  <div class="atlas-shell">
    <header class="app-header row-between">
      <a class="brand" href="/" aria-label="Cubiomes Next 首页"
        ><span class="brand-cube" aria-hidden="true"><i></i></span
        ><span
          >CUBIOMES<span class="brand-next">NEXT</span
          ><small>你的世界，从一颗种子开始。</small></span
        ></a
      >
      <div class="header-right flex items-center gap-3">
        <span class="engine-pill"
          ><span class="status-dot" :class="{ working: busy }"></span
          >{{ backend }}</span
        >
        <a
          class="repo-link"
          href="https://github.com/Dustella/cubiomes_next"
          target="_blank"
          rel="noopener noreferrer"
          >源码 <span aria-hidden="true">↗</span></a
        >
        <button
          class="icon-button mobile-settings"
          @click="openTab('world')"
          aria-label="打开世界设置"
        >
          ☷
        </button>
      </div>
    </header>

    <aside
      class="sidebar"
      :class="{ 'is-open': panelOpen }"
      aria-label="地图控制面板"
    >
      <div class="sidebar-heading row-between">
        <div>
          <p class="eyebrow muted">SEED EXPLORER</p>
          <h1>探索你的世界<span class="title-dot">.</span></h1>
        </div>
        <button
          class="icon-button close-panel"
          aria-label="关闭控制面板"
          @click="panelOpen = false"
        >
          ×
        </button>
      </div>
      <nav class="panel-tabs" aria-label="控制面板分类">
        <button :class="{ active: tab === 'world' }" @click="tab = 'world'">
          世界</button
        ><button :class="{ active: tab === 'layers' }" @click="tab = 'layers'">
          结构图层
          <span v-if="selectedLayers.length">{{
            selectedLayers.length
          }}</span></button
        ><button :class="{ active: tab === 'biomes' }" @click="tab = 'biomes'">
          群系
        </button>
      </nav>
      <div class="panel-scroll">
        <form
          v-show="tab === 'world'"
          @submit.prevent="applyWorld()"
          class="world-form"
        >
          <label class="field-label" for="seed"
            >世界种子 <span>SEED</span></label
          >
          <div class="seed-field">
            <input
              id="seed"
              v-model="seed"
              autocomplete="off"
              spellcheck="false"
              placeholder="数字或文字种子"
            /><button
              type="button"
              aria-label="随机种子"
              title="随机种子"
              @click="randomSeed"
            >
              ⤨
            </button>
          </div>
          <p class="field-hint">支持 64 位数字种子，也支持文字种子。</p>
          <label class="field-label" for="version"
            >游戏版本 <span>JAVA EDITION</span></label
          >
          <select id="version" v-model="version">
            <option v-for="item in versions" :key="item.id" :value="item.id">
              {{ item.label }}
            </option>
          </select>
          <div class="section-label">维度 <span>DIMENSION</span></div>
          <div class="dimension-options">
            <button
              v-for="dim in dimensions"
              :key="dim.id"
              type="button"
              :class="{ selected: dimension === dim.id }"
              :aria-pressed="dimension === dim.id"
              @click="
                dimension = dim.id;
                applyWorld(false);
              "
            >
              <span aria-hidden="true">{{ dim.glyph }}</span
              >{{ dim.name }}
            </button>
          </div>
          <div class="section-divider"></div>
          <div class="row-between">
            <div class="section-label">观察位置</div>
            <button type="button" class="text-button" @click="origin">
              回到原点 ↗
            </button>
          </div>
          <div class="coordinate-fields">
            <label for="cx"
              ><span>X</span
              ><input
                id="cx"
                v-model.number="cx"
                type="number"
                min="-29000000"
                max="29000000"
                step="1"
                required /></label
            ><label for="cz"
              ><span>Z</span
              ><input
                id="cz"
                v-model.number="cz"
                type="number"
                min="-29000000"
                max="29000000"
                step="1"
                required
            /></label>
          </div>
          <label class="field-label" for="y"
            >采样高度 <span>Y LEVEL</span></label
          >
          <div class="height-field">
            <input
              id="y"
              v-model.number="height"
              type="number"
              min="-2048"
              max="2048"
              step="1"
              required
            /><span>方块</span>
          </div>
          <button class="primary-button" type="submit">
            <span aria-hidden="true">⌕</span> 生成地图 <kbd>↵</kbd>
          </button>
          <div class="info-note">
            <span aria-hidden="true">ⓘ</span>
            <p>
              这是群系采样地图，不是地形高度图。结构标记也不代表完整游戏生成结果。
            </p>
          </div>
        </form>
        <section v-show="tab === 'layers'" class="layers-panel">
          <div class="row-between mb-3">
            <h2>在地图上显示</h2>
            <button
              class="text-button"
              @click="
                selectedLayers = [];
                selectedMarker = null;
                render();
              "
            >
              全部隐藏
            </button>
          </div>
          <p class="panel-description">
            候选位置经过当前版本支持的筛选；点击标记查看计算范围。密集图层仅扫描视图中心附近。
          </p>
          <div v-if="!layers.length" class="empty-note">
            {{ busy ? "正在加载此版本的结构…" : "此维度没有可用的结构图层。" }}
          </div>
          <p v-if="layerError" class="panel-description" role="alert">
            {{ layerError }}
          </p>
          <label v-for="layer in layers" :key="layer.id" class="layer-option"
            ><input
              type="checkbox"
              :checked="selectedLayers.includes(layer.id)"
              @change="toggleLayer(layer.id)"
            /><span class="layer-glyph" :style="{ color: layer.color }">◆</span
            ><span
              >{{ layer.label }}<small>{{ layer.detail }}</small></span
            ></label
          >
          <div class="info-note">
            <span aria-hidden="true">◇</span>
            <p v-if="version === '26.2'">
              26.2
              实验：仅候选位置、频率与排除规则；尚未移植完整生成起点、地形和布局。
            </p>
            <p v-else>
              WASM Worker
              负责结构计算。群系筛选不等于完整地形验证；请以游戏内结果为准。
            </p>
          </div>
        </section>
        <section v-show="tab === 'biomes'" class="biomes-panel">
          <div class="row-between mb-3">
            <h2>视野内群系</h2>
            <span class="small-chip">{{ legend.length }}</span>
          </div>
          <p class="panel-description">当前高度的采样占比，随地图视野更新。</p>
          <div v-for="item in legend" :key="item.name" class="biome-row">
            <span
              class="biome-swatch"
              :style="{ background: item.color }"
            ></span
            ><span class="biome-name">{{ friendly(item.name) }}</span
            ><span class="mono muted">{{ item.percent }}%</span>
          </div>
          <div v-if="!legend.length" class="empty-note">
            生成地图后显示群系。
          </div>
        </section>
      </div>
      <footer class="sidebar-footer">
        <span class="status-dot"></span>本地计算 · 种子不会上传<small
          >CUBIOMES BASELINE / CLEAN-ROOM</small
        >
      </footer>
    </aside>
    <button
      v-if="panelOpen"
      class="panel-scrim"
      aria-label="关闭控制面板"
      @click="panelOpen = false"
    ></button>

    <main class="map-main" aria-label="种子地图">
      <div
        ref="surface"
        class="map-surface"
        tabindex="0"
        role="application"
        aria-label="群系地图。拖动平移，滚轮或双指缩放，也可使用方向键与加减键。"
        :aria-busy="busy"
        @pointerdown="pointerDown"
        @pointermove="pointerMove"
        @pointerup="pointerUp"
        @pointercancel="pointerUp"
        @wheel="wheel"
        @keydown="keyboard"
      >
        <div
          class="map-content"
          :style="{
            transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
          }"
        >
          <canvas
            ref="canvas"
            id="map"
            :class="{ 'has-frame': frame }"
            aria-label="Minecraft 群系颜色地图"
          ></canvas>
          <div v-if="grid" class="map-grid" aria-hidden="true"></div>
          <button
            v-for="marker in visibleMarkers"
            :key="marker.id"
            class="map-marker"
            :class="{ chosen: selectedMarker?.id === marker.id }"
            :style="{
              left: `${marker.left}%`,
              top: `${marker.top}%`,
              '--marker-color': layerById.get(marker.layer)?.color ?? '#e5c379',
            }"
            :aria-label="`${marker.label}，X ${marker.x}，Z ${marker.z}`"
            @pointerdown.stop
            @click.stop="selectedMarker = marker"
          >
            <span aria-hidden="true">◆</span>
          </button>
        </div>
        <div class="center-cross" aria-hidden="true"></div>
      </div>
      <div class="map-topline">
        <div class="map-context">
          <span class="context-icon" aria-hidden="true">{{
            dimensions.find((d) => d.id === dimension)?.glyph
          }}</span>
          <div>
            <strong>{{ dimensionName }}</strong
            ><span
              >JAVA {{ frame?.world.version ?? version }} <i>·</i> Y
              {{ frame?.world.y ?? height }}</span
            >
          </div>
        </div>
        <div class="map-actions">
          <button
            class="icon-button"
            :aria-pressed="grid"
            aria-label="切换参考网格（非区块网格）"
            title="参考网格（非区块网格）"
            @click="grid = !grid"
          >
            ▦</button
          ><button
            class="icon-button"
            aria-label="导出群系 PNG"
            title="导出群系 PNG（不含结构）"
            :disabled="!frame || busy"
            @click="exportImage"
          >
            ↓</button
          ><button
            class="icon-button"
            aria-label="复制地图链接"
            title="复制地图链接"
            :disabled="!frame || busy"
            @click="shareLink"
          >
            ↗
          </button>
        </div>
      </div>
      <div v-if="!frame && !error" class="map-loading">
        <span class="loading-cube"></span><strong>正在寻找你的世界</strong
        ><span>首次使用需要编译计算着色器</span>
      </div>
      <div v-if="error" class="map-error" role="alert">
        <strong>地图计算遇到问题</strong>
        <p>{{ error }}</p>
        <button class="secondary-button" @click="applyWorld(false)">重试</button
        ><button class="text-button" @click="openTab('world')">
          检查世界设置
        </button>
      </div>
      <div v-if="busy" class="map-progress" role="status">{{ status }}</div>
      <div class="map-navigation">
        <div class="compass" aria-label="地图上方为北方">
          <span>N</span><b>↑</b>
        </div>
        <div class="zoom-controls">
          <button
            aria-label="放大地图"
            :disabled="zoom === 4"
            @click="setZoom(-1)"
          >
            +</button
          ><span></span
          ><button
            aria-label="缩小地图"
            :disabled="zoom === 128"
            @click="setZoom(1)"
          >
            −
          </button>
        </div>
        <button
          class="icon-button origin-button"
          aria-label="地图回到原点"
          title="回到原点"
          @click="origin"
        >
          ⌖
        </button>
      </div>
      <article v-if="selectedMarker" class="marker-card">
        <div class="row-between">
          <span class="eyebrow muted">STRUCTURE CANDIDATE</span
          ><button
            class="icon-button"
            aria-label="关闭结构详情"
            @click="selectedMarker = null"
          >
            ×
          </button>
        </div>
        <h2>{{ selectedMarker.label }}</h2>
        <p class="marker-coordinates mono">
          X {{ selectedMarker.x }} <span>／</span> Z {{ selectedMarker.z }}
        </p>
        <p>{{ selectedMarker.detail }}</p>
        <button
          class="secondary-button"
          @click="copy(`${selectedMarker.x} ~ ${selectedMarker.z}`)"
        >
          复制坐标
        </button>
      </article>
      <div class="map-bottomline">
        <div class="coordinate-readout">
          <span class="readout-label">{{ hover ? "光标" : "中心" }}</span
          ><span class="mono"
            >X {{ hover?.x ?? cx }} <i>·</i> Z {{ hover?.z ?? cz }}</span
          ><strong v-if="hover">{{ hover.name }}</strong>
        </div>
        <div class="map-scale">
          <span>{{ scale.blocks.toLocaleString() }} 方块</span>
          <div :style="{ width: `${scale.pixels}px` }"></div>
        </div>
      </div>
      <div class="map-footer">
        <span
          ><span class="status-dot" :class="{ working: busy }"></span
          >{{ busy ? "计算中" : error ? "发生错误" : "就绪" }}<i>·</i
          >{{ markers.length }} 个结构标记</span
        ><span class="footer-seed mono" :title="displaySeed"
          >SEED {{ displaySeed }}</span
        ><span class="performance mono">{{ elapsed.toFixed(0) }} ms</span>
      </div>
      <nav class="mobile-nav" aria-label="移动端工具">
        <button @click="openTab('world')">
          <span aria-hidden="true">▧</span>世界设置</button
        ><button @click="openTab('layers')">
          <span aria-hidden="true">◇</span>结构图层
          <small v-if="selectedLayers.length">{{
            selectedLayers.length
          }}</small></button
        ><button @click="openTab('biomes')">
          <span aria-hidden="true">▥</span>群系图例
        </button>
      </nav>
    </main>
    <div v-if="notice" class="toast" role="status">{{ notice }}</div>
  </div>
</template>

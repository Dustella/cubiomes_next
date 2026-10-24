<script setup lang="ts" vapor>
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { parseSeed } from "../core/rng";
import { biomeColor } from "./colors";
import { MapBoard, type BoardStatus } from "./map/board";
import { MAX_SCALE, MIN_SCALE, scaleBar, type Camera } from "./map/camera";
import { iconURL } from "./map/icons";
import {
  ViewerRuntime,
  type ViewWorld,
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
  cz = ref(0);
const camera = shallowRef<Camera>({ x: 0, z: 0, scale: 8 });
const world = shallowRef<ViewWorld | null>(null);
const tab = ref("world"),
  panelOpen = ref(false);
const mobileQuery = matchMedia("(max-width: 760px)");
const mobile = ref(mobileQuery.matches);
const syncMobile = (): void => {
  mobile.value = mobileQuery.matches;
};
const panel = ref<HTMLElement>();
const canvas = ref<HTMLCanvasElement>(),
  surface = ref<HTMLDivElement>();
const layers = ref<ViewLayer[]>([]),
  selectedLayers = ref<string[]>([]);
const markers = shallowRef<ViewMarker[]>([]),
  selectedMarker = shallowRef<ViewMarker | null>(null);
const tiles = shallowRef<BoardStatus>({ missing: 1, loading: 0, ready: false, backend: "", lastMs: 0 });
const hasFrame = ref(false);
const markerBusy = ref(false);
const busy = computed(() => tiles.value.loading > 0 || tiles.value.missing > 0 || markerBusy.value);
const error = ref(""),
  layerError = ref(""),
  markerNote = ref("");
const grid = ref(false);
const hover = ref<{ x: number; z: number; name: string } | null>(null);
const legend = ref<{ name: string; color: string; percent: string }[]>([]);
const notice = ref("");
const dimensions = [
  { id: "overworld", name: "主世界", glyph: "▰" },
  { id: "nether", name: "下界", glyph: "♨" },
  { id: "end", name: "末地", glyph: "✧" },
] as const;
const dimensionName = computed(
  () => dimensions.find((d) => d.id === dimension.value)?.name ?? "主世界",
);
const backend = computed(() => tiles.value.backend || "初始化");
const status = computed(() =>
  tiles.value.loading || tiles.value.missing
    ? `正在计算群系图块 · 剩余 ${tiles.value.missing}`
    : markerBusy.value
      ? "正在计算结构图层…"
      : "",
);
const displaySeed = computed(() => world.value?.seed.toString() ?? seed.value);
const layerColors = computed(
  () => new Map(layers.value.map((layer) => [layer.id, layer.color])),
);
const layerById = computed(
  () => new Map(layers.value.map((layer) => [layer.id, layer])),
);
/** Markers inside the viewport, nearest the centre first (accessible list). */
const visibleMarkers = computed(() => {
  const c = camera.value, b = board?.bounds();
  if (!b) return [];
  return markers.value
    .filter((m) => m.x >= b.minX && m.x < b.maxX && m.z >= b.minZ && m.z < b.maxZ)
    .map((m) => ({ marker: m, d: Math.hypot(m.x - c.x, m.z - c.z) }))
    .sort((a, b2) => a.d - b2.d)
    .slice(0, 60)
    .map((e) => e.marker);
});
const scale = computed(() => scaleBar(camera.value.scale, mobile.value ? 65 : 110));
const friendly = (name: string): string =>
  name
    .replace(/^minecraft:/, "")
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
const color = (name: string): string =>
  "#" + biomeColor(name).toString(16).padStart(6, "0");
const icon = (layer: string): string =>
  iconURL(layer, layerColors.value.get(layer) ?? "#e5c379");

let board: MapBoard | undefined;
let disposed = false,
  toastTimer = 0,
  markerSeq = 0,
  markerRunning = false,
  markerAgain = false;
let layerKey = "";

function toast(message: string): void {
  notice.value = message;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    notice.value = "";
  }, 2800);
}
function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
function updateURL(): void {
  const w = world.value, c = camera.value;
  if (!w) return;
  const params = new URLSearchParams({
    seed: w.seed.toString(),
    version: w.version,
    dim: w.dimension,
    x: String(Math.round(c.x)),
    z: String(Math.round(c.z)),
    y: String(w.y),
    scale: String(+c.scale.toPrecision(4)),
  });
  for (const id of selectedLayers.value) params.append("layer", id);
  history.replaceState(null, "", `${location.pathname}?${params}`);
}
function refreshLegend(): void {
  const stats = board?.biomeStats() ?? [];
  const total = stats.reduce((n, s) => n + s.count, 0) || 1;
  legend.value = stats.map((s) => ({
    name: s.name,
    color: color(s.name),
    percent: ((s.count / total) * 100).toFixed(1),
  }));
}

/** World key changed: refresh the structure layer list (structure lane). */
async function loadLayers(activeWorld: ViewWorld): Promise<void> {
  const key = `${activeWorld.version}/${activeWorld.dimension}/${activeWorld.seed}`;
  if (key === layerKey) return;
  layerKey = key;
  layerError.value = "";
  try {
    const next = await runtime.layers(activeWorld);
    if (world.value !== activeWorld) return;
    layers.value = next;
    selectedLayers.value = selectedLayers.value.filter((id) => next.some((l) => l.id === id));
  } catch (reason) {
    if (world.value !== activeWorld) return;
    layers.value = [];
    layerError.value = `结构图层不可用：${message(reason)}`;
  }
}

/** Latest-only marker query for the viewport plus a 50% margin. Old markers
 * stay on the board until the new result arrives, so panning never flickers. */
async function refreshMarkers(): Promise<void> {
  if (markerRunning) {
    markerAgain = true;
    return;
  }
  markerRunning = true;
  try {
    do {
      markerAgain = false;
      const activeWorld = world.value, seq = ++markerSeq;
      if (!activeWorld || !board || disposed) return;
      await loadLayers(activeWorld);
      const ids = [...selectedLayers.value];
      if (!ids.length) {
        markers.value = [];
        markerNote.value = "";
        board.setMarkers([], layerColors.value);
        continue;
      }
      const b = board.bounds(), padX = (b.maxX - b.minX) / 2, padZ = (b.maxZ - b.minZ) / 2;
      markerBusy.value = true;
      try {
        const result = await runtime.markers(activeWorld, {
          minX: Math.floor(b.minX - padX),
          minZ: Math.floor(b.minZ - padZ),
          maxX: Math.ceil(b.maxX + padX),
          maxZ: Math.ceil(b.maxZ + padZ),
        }, ids);
        if (seq !== markerSeq || world.value !== activeWorld || disposed) continue;
        markers.value = result;
        markerNote.value = result.some((m) => /clipped/.test(m.detail))
          ? "视野较大，结构仅扫描中心区域；放大可查看更多。"
          : "";
        board.setMarkers(result, layerColors.value);
        if (selectedMarker.value && !result.some((m) => m.id === selectedMarker.value!.id))
          selectedMarker.value = null;
      } catch (reason) {
        if (seq === markerSeq) layerError.value = `结构计算失败：${message(reason)}`;
      }
    } while (markerAgain && !disposed);
  } finally {
    markerRunning = false;
    markerBusy.value = false;
  }
}

function applyWorld(close = true): void {
  try {
    if (!Number.isInteger(height.value) || height.value < -2048 || height.value > 2048)
      throw new RangeError("Y 必须是 -2048 到 2048 之间的整数");
    if (![cx.value, cz.value].every((n) => Number.isInteger(n) && Math.abs(n) <= 29_000_000))
      throw new RangeError("中心坐标必须是 ±29,000,000 内的整数");
    const next: ViewWorld = {
      version: version.value,
      dimension: dimension.value,
      seed: parseSeed(seed.value),
      y: height.value,
    };
    const prev = world.value;
    const changed =
      !prev ||
      next.version !== prev.version ||
      next.dimension !== prev.dimension ||
      next.seed !== prev.seed ||
      next.y !== prev.y;
    error.value = "";
    if (changed) {
      world.value = next;
      markers.value = [];
      selectedMarker.value = null;
      hover.value = null;
      legend.value = [];
      board?.setMarkers([], layerColors.value);
      board?.reset();
    }
    const c = camera.value;
    if (Math.round(c.x) !== cx.value || Math.round(c.z) !== cz.value)
      board?.setCamera({ x: cx.value, z: cz.value });
    else board?.retry();
    if (close) panelOpen.value = false;
    void refreshMarkers();
  } catch (reason) {
    error.value = message(reason);
  }
}
function randomSeed(): void {
  const data = crypto.getRandomValues(new BigUint64Array(1));
  seed.value = BigInt.asIntN(64, data[0]!).toString();
  applyWorld();
}
function zoom(direction: number): void {
  board?.zoomBy(direction > 0 ? 2 : 0.5);
}
function origin(): void {
  selectedMarker.value = null;
  board?.select(null);
  board?.setCamera({ x: 0, z: 0 });
}
function toggleLayer(id: string): void {
  selectedLayers.value = selectedLayers.value.includes(id)
    ? selectedLayers.value.filter((item) => item !== id)
    : [...selectedLayers.value, id];
  updateURL();
  void refreshMarkers();
}
function hideLayers(): void {
  selectedLayers.value = [];
  selectedMarker.value = null;
  board?.select(null);
  updateURL();
  void refreshMarkers();
}
function chooseMarker(marker: ViewMarker | null, center = false): void {
  selectedMarker.value = marker;
  board?.select(marker, center);
}
function toggleGrid(): void {
  grid.value = !grid.value;
  board?.setGrid(grid.value);
}
function openTab(next: string): void {
  tab.value = next;
  panelOpen.value = true;
  if (mobile.value)
    void nextTick(() =>
      panel.value?.querySelector<HTMLButtonElement>(".close-panel")?.focus(),
    );
}
function panelKeyboard(event: KeyboardEvent): void {
  if (!mobile.value || !panelOpen.value) return;
  if (event.key === "Escape") {
    panelOpen.value = false;
    surface.value?.focus();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    panel.value!.querySelectorAll<HTMLElement>("button, input, select, a[href]"),
  ).filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0);
  const first = focusable[0],
    last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
  } catch {
    toast("无法访问剪贴板，请从地址栏或坐标栏手动复制");
  }
}
function shareLink(): void {
  updateURL();
  void copy(location.href);
}
function exportImage(): void {
  if (!board || !world.value) return;
  const link = document.createElement("a");
  link.download = `cubiomes-${world.value.version}-${world.value.seed}.png`;
  link.href = board.exportPNG();
  link.click();
  toast("已导出当前视野（含结构图标）");
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
    board?.panBy(delta[0] * 100, delta[1] * 100);
  } else if (event.key === "+" || event.key === "=") zoom(-1);
  else if (event.key === "-") zoom(1);
  else if (event.key === "Escape") chooseMarker(null);
}

function source(region: { x0: number; z0: number; w: number; h: number; step: number }) {
  const activeWorld = world.value;
  if (!activeWorld) return Promise.reject(new Error("World is not ready"));
  return runtime.frame(activeWorld, region);
}

onMounted(async () => {
  mobileQuery.addEventListener("change", syncMobile);
  try {
    versions.value = await runtime.versions();
    const params = new URLSearchParams(location.search);
    selectedLayers.value = [...new Set(params.getAll("layer"))].slice(0, 64);
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
      if (raw !== null && Number.isInteger(Number(raw))) target.value = Number(raw);
    }
    // `scale` is blocks per CSS pixel; legacy `zoom` links meant twice that.
    const rawScale = Number(params.get("scale") ?? Number(params.get("zoom") ?? 16) / 2);
    const initialScale = Number.isFinite(rawScale) && rawScale > 0
      ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, rawScale))
      : 8;
    camera.value = { x: cx.value, z: cz.value, scale: initialScale };
    applyWorld(false);
    board = new MapBoard(canvas.value!, source, {
      camera(c) {
        camera.value = c;
        cx.value = Math.round(c.x);
        cz.value = Math.round(c.z);
      },
      settled() {
        updateURL();
        refreshLegend();
        void refreshMarkers();
      },
      hover(info) {
        hover.value = info ? { x: info.x, z: info.z, name: info.biome ? friendly(info.biome) : "加载中…" } : null;
      },
      select(marker) {
        selectedMarker.value = marker;
      },
      status(s) {
        tiles.value = s;
        if (s.ready) {
          hasFrame.value = true;
          error.value = "";
          refreshLegend();
        }
      },
      error(reason) {
        error.value = reason.message;
      },
    }, camera.value);
    board.setGrid(grid.value);
    void refreshMarkers();
  } catch (reason) {
    error.value = message(reason);
  }
});
onUnmounted(() => {
  disposed = true;
  board?.destroy();
  runtime.destroy();
  mobileQuery.removeEventListener("change", syncMobile);
  clearTimeout(toastTimer);
});
</script>

<template>
  <div class="atlas-shell">
    <header class="app-header row-between" :inert="mobile && panelOpen">
      <a class="brand" href="/" aria-label="Cubiomes Next 首页"
        ><span class="brand-cube" aria-hidden="true"><i></i></span
        ><span
          >CUBIOMES<span class="brand-next">NEXT</span
          ><small>你的世界，从一颗种子开始。</small></span
        ></a
      >
      <div class="header-right flex items-center gap-3">
        <span class="engine-pill" :title="backend"
          ><span class="status-dot" :class="{ working: busy }"></span
          >{{ backend.startsWith("CPU worker") ? "CPU worker" : backend }}</span
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
      ref="panel"
      :inert="mobile && !panelOpen"
      :role="mobile && panelOpen ? 'dialog' : undefined"
      :aria-modal="mobile && panelOpen ? true : undefined"
      @keydown="panelKeyboard"
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
            <button class="text-button" @click="hideLayers">
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
          <p v-if="markerNote" class="panel-description">{{ markerNote }}</p>
          <label v-for="layer in layers" :key="layer.id" class="layer-option"
            ><input
              type="checkbox"
              :checked="selectedLayers.includes(layer.id)"
              @change="toggleLayer(layer.id)"
            /><img
              class="layer-icon"
              :src="icon(layer.id)"
              alt=""
              width="24"
              height="24"
            /><span
              >{{ layer.label }}<small>{{ layer.detail }}</small></span
            ></label
          >
          <div v-if="visibleMarkers.length" class="marker-list">
            <div class="row-between mb-2">
              <h2>视野内结构</h2>
              <span class="small-chip">{{ visibleMarkers.length }}</span>
            </div>
            <button
              v-for="marker in visibleMarkers"
              :key="marker.id"
              class="marker-row"
              :class="{ chosen: selectedMarker?.id === marker.id }"
              @click="chooseMarker(marker, true)"
            >
              <img :src="icon(marker.layer)" alt="" width="18" height="18" /><span>{{
                layerById.get(marker.layer)?.label ?? marker.label
              }}</span
              ><span class="mono muted">{{ marker.x }}, {{ marker.z }}</span>
            </button>
          </div>
          <div class="info-note">
            <span aria-hidden="true">◇</span>
            <p v-if="world?.version === '26.2'">
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

    <main class="map-main" aria-label="种子地图" :inert="mobile && panelOpen">
      <div
        ref="surface"
        class="map-surface"
        tabindex="0"
        role="application"
        aria-label="群系地图。拖动平移，滚轮或双指缩放，也可使用方向键与加减键。结构列表位于结构图层面板。"
        :aria-busy="busy"
        @keydown="keyboard"
      >
        <canvas
          ref="canvas"
          id="map"
          :class="{ 'has-frame': hasFrame }"
          aria-label="Minecraft 群系颜色地图"
        ></canvas>
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
              >JAVA {{ world?.version ?? version }} <i>·</i> Y
              {{ world?.y ?? height }}</span
            >
          </div>
        </div>
        <div class="map-actions">
          <button
            class="icon-button"
            :aria-pressed="grid"
            aria-label="切换坐标网格"
            title="坐标网格（16 方块整数倍，金线为 0 轴）"
            @click="toggleGrid"
          >
            ▦</button
          ><button
            class="icon-button"
            aria-label="导出当前视野 PNG"
            title="导出当前视野 PNG（含结构图标）"
            :disabled="!hasFrame"
            @click="exportImage"
          >
            ↓</button
          ><button
            class="icon-button"
            aria-label="复制地图链接"
            title="复制地图链接"
            :disabled="!world"
            @click="shareLink"
          >
            ↗
          </button>
        </div>
      </div>
      <div v-if="!hasFrame && !error" class="map-loading">
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
            :disabled="camera.scale <= MIN_SCALE"
            @click="zoom(-1)"
          >
            +</button
          ><span></span
          ><button
            aria-label="缩小地图"
            :disabled="camera.scale >= MAX_SCALE"
            @click="zoom(1)"
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
            @click="chooseMarker(null)"
          >
            ×
          </button>
        </div>
        <h2 class="marker-title">
          <img :src="icon(selectedMarker.layer)" alt="" width="24" height="24" />{{
            selectedMarker.label
          }}
        </h2>
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
        ><span class="performance mono">{{ tiles.lastMs.toFixed(0) }} ms / 图块</span>
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

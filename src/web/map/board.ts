// Canvas map board, independent of how biomes/structures are computed.
//
// - Camera is a float block-space centre + blocks-per-CSS-pixel scale. Pan and
//   zoom only change the camera and schedule one rAF redraw; nothing is
//   recomputed on pointerup, so there is no full-page repaint or snap-back.
// - Biome data arrives as world-aligned tiles (see camera.ts) requested from a
//   caller-supplied source. Tiles and markers are drawn with the same camera
//   transform, so they cannot drift relative to each other.
// - While tiles for the current zoom are loading, cached coarser/finer tiles
//   are drawn underneath as a placeholder.
import { biomeColor } from '../colors';
import type { ViewFrame, ViewMarker } from '../viewer-types';
import { ICON_SIZE, iconCanvas } from './icons';
import {
  TILE, WORLD_LIMIT, clampCoord, clampScale, gridSpacing, levelFor, screenToWorld,
  tileBlocks, tileRange, tileRegion, viewBounds, zoomAt,
  type Camera, type Viewport,
} from './camera';

export type TileSource = (region: { x0: number; z0: number; w: number; h: number; step: number }) => Promise<ViewFrame>;
export interface BoardStatus { missing: number; loading: number; ready: boolean; backend: string; lastMs: number }
export interface BoardHover { x: number; z: number; biome: string | null }
export interface BoardEvents {
  /** Fired at most once per animation frame while the camera moves. */
  camera?(camera: Camera): void;
  /** Fired once movement has paused; use for marker queries and URL updates. */
  settled?(camera: Camera): void;
  hover?(info: BoardHover | null): void;
  select?(marker: ViewMarker | null): void;
  status?(status: BoardStatus): void;
  error?(error: Error): void;
}

interface Tile { key: string; level: number; tx: number; tz: number; biomes: Uint32Array; names: string[]; image: HTMLCanvasElement; used: number }
type Gesture =
  | { kind: 'drag'; id: number; sx: number; sy: number; x: number; z: number; moved: boolean }
  | { kind: 'pinch'; dist: number; scale: number; wx: number; wz: number };

const MAX_TILES = 192;
const CONCURRENCY = 2;
const SETTLE_MS = 180;
const BACKGROUND = '#15201b';
const tileKey = (level: number, tx: number, tz: number): string => `${level}/${tx}/${tz}`;

export class MapBoard {
  private readonly ctx: CanvasRenderingContext2D;
  private camera: Camera;
  private view: Viewport = { width: 1, height: 1 };
  private dpr = 1;
  private rect = new DOMRect();
  private readonly tiles = new Map<string, Tile>();
  private inflight = new Set<string>();
  private failed = new Set<string>();
  private generation = 0;
  private frame = 0;
  private settleTimer = 0;
  private cameraMoved = false;
  private markers: ViewMarker[] = [];
  private styles = new Map<string, string>();
  private selected: ViewMarker | null = null;
  private grid = false;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private gesture: Gesture | null = null;
  private readonly resize: ResizeObserver;
  private status: BoardStatus = { missing: 0, loading: 0, ready: false, backend: '', lastMs: 0 };
  private destroyed = false;

  constructor(readonly canvas: HTMLCanvasElement, private readonly source: TileSource, private readonly events: BoardEvents, camera: Camera) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.camera = { x: clampCoord(camera.x), z: clampCoord(camera.z), scale: clampScale(camera.scale) };
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(canvas);
    this.measure();
  }

  // ---------------------------------------------------------------- public API
  getCamera(): Camera { return { ...this.camera }; }
  getViewport(): Viewport { return { ...this.view }; }
  setCamera(next: Partial<Camera>): void {
    this.camera = {
      x: clampCoord(next.x ?? this.camera.x), z: clampCoord(next.z ?? this.camera.z),
      scale: clampScale(next.scale ?? this.camera.scale),
    };
    this.moved();
  }
  panBy(dxPx: number, dyPx: number): void {
    this.setCamera({ x: this.camera.x + dxPx * this.camera.scale, z: this.camera.z + dyPx * this.camera.scale });
  }
  zoomBy(factor: number, sx = this.view.width / 2, sy = this.view.height / 2): void {
    this.camera = zoomAt(this.camera, this.view, sx, sy, this.camera.scale * factor);
    this.moved();
  }
  /** Drop all biome data (world, seed or Y changed). Camera is kept. */
  reset(): void {
    this.generation++;
    this.tiles.clear();
    this.inflight = new Set();
    this.failed = new Set();
    this.status = { ...this.status, ready: false };
    this.invalidate();
    this.scheduleSettle();
  }
  /** Retry tiles that failed (e.g. after a transient GPU error). */
  retry(): void { this.failed = new Set(); this.invalidate(); }
  setMarkers(markers: ViewMarker[], styles: Map<string, string>): void {
    this.markers = markers;
    this.styles = styles;
    if (this.selected && !markers.some(m => m.id === this.selected!.id)) this.selected = null;
    this.invalidate();
  }
  select(marker: ViewMarker | null, center = false): void {
    this.selected = marker;
    if (marker && center) this.setCamera({ x: marker.x, z: marker.z });
    this.invalidate();
  }
  setGrid(on: boolean): void { this.grid = on; this.invalidate(); }
  gridBlocks(): number { return gridSpacing(this.camera.scale); }
  bounds(): ReturnType<typeof viewBounds> { return viewBounds(this.camera, this.view); }
  isReady(): boolean { return this.status.ready; }

  /** Biome sample counts inside the viewport at the current level. */
  biomeStats(): { name: string; count: number }[] {
    const level = levelFor(this.camera.scale), r = tileRange(this.camera, this.view, level), b = this.bounds();
    const counts = new Map<string, number>();
    const step = 2 ** level, blocks = step * 4;
    for (let tz = r.tz0; tz <= r.tz1; tz++) for (let tx = r.tx0; tx <= r.tx1; tx++) {
      const tile = this.tiles.get(tileKey(level, tx, tz));
      if (!tile) continue;
      const ox = tx * TILE * blocks, oz = tz * TILE * blocks;
      const i0 = Math.max(0, Math.floor((b.minX - ox) / blocks)), i1 = Math.min(TILE, Math.ceil((b.maxX - ox) / blocks));
      const j0 = Math.max(0, Math.floor((b.minZ - oz) / blocks)), j1 = Math.min(TILE, Math.ceil((b.maxZ - oz) / blocks));
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
        const name = tile.names[tile.biomes[j * TILE + i]!] ?? 'unknown';
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b2) => b2.count - a.count);
  }

  /** PNG of exactly what is on screen, including structure icons and grid. */
  exportPNG(): string { this.draw(); return this.canvas.toDataURL('image/png'); }

  destroy(): void {
    this.destroyed = true;
    this.generation++;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.settleTimer);
    this.resize.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.tiles.clear();
  }

  // ------------------------------------------------------------- render loop
  private invalidate(): void {
    if (!this.frame && !this.destroyed) this.frame = requestAnimationFrame(() => this.draw());
  }
  private moved(): void {
    this.cameraMoved = true;
    this.invalidate();
    this.scheduleSettle();
  }
  private scheduleSettle(): void {
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      if (!this.destroyed && !this.gesture) this.events.settled?.(this.getCamera());
      else if (this.gesture) this.scheduleSettle();
    }, SETTLE_MS);
  }
  private measure(): void {
    const width = Math.max(1, this.canvas.clientWidth), height = Math.max(1, this.canvas.clientHeight);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.rect = this.canvas.getBoundingClientRect();
    if (width === this.view.width && height === this.view.height && dpr === this.dpr) return;
    this.view = { width, height };
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.moved();
  }

  private draw(): void {
    this.frame = 0;
    if (this.destroyed) return;
    const { ctx, dpr, camera: c, view: v } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const level = levelFor(c.scale), b = viewBounds(c, v), now = performance.now();
    // Placeholders first (coarsest first, then finer), current level last.
    const visible: Tile[] = [];
    for (const tile of this.tiles.values()) {
      if (Math.abs(tile.level - level) > 5) continue;
      const size = tileBlocks(tile.level), x0 = tile.tx * size, z0 = tile.tz * size;
      if (x0 >= b.maxX || z0 >= b.maxZ || x0 + size <= b.minX || z0 + size <= b.minZ) continue;
      visible.push(tile);
    }
    const rank = (t: Tile): number => t.level === level ? 1000 : t.level > level ? -t.level : 100 - t.level;
    visible.sort((a, b2) => rank(a) - rank(b2));
    for (const tile of visible) {
      const size = tileBlocks(tile.level);
      const x0 = Math.round(((tile.tx * size - c.x) / c.scale + v.width / 2) * dpr);
      const z0 = Math.round(((tile.tz * size - c.z) / c.scale + v.height / 2) * dpr);
      const x1 = Math.round((((tile.tx + 1) * size - c.x) / c.scale + v.width / 2) * dpr);
      const z1 = Math.round((((tile.tz + 1) * size - c.z) / c.scale + v.height / 2) * dpr);
      ctx.drawImage(tile.image, x0, z0, x1 - x0, z1 - z0);
      tile.used = now;
    }
    if (this.grid) this.drawGrid();
    this.drawMarkers();
    if (this.cameraMoved) { this.cameraMoved = false; this.events.camera?.(this.getCamera()); }
    this.schedule(level);
  }

  private drawGrid(): void {
    const { ctx, dpr, camera: c, view: v } = this;
    const spacing = gridSpacing(c.scale), b = viewBounds(c, v);
    const sx = (x: number): number => Math.round(((x - c.x) / c.scale + v.width / 2) * dpr) + 0.5;
    const sz = (z: number): number => Math.round(((z - c.z) / c.scale + v.height / 2) * dpr) + 0.5;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(235,255,220,0.22)';
    ctx.beginPath();
    for (let x = Math.ceil(b.minX / spacing) * spacing; x < b.maxX; x += spacing) { ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), this.canvas.height); }
    for (let z = Math.ceil(b.minZ / spacing) * spacing; z < b.maxZ; z += spacing) { ctx.moveTo(0, sz(z)); ctx.lineTo(this.canvas.width, sz(z)); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,240,170,0.55)';
    ctx.beginPath();
    if (b.minX <= 0 && b.maxX >= 0) { ctx.moveTo(sx(0), 0); ctx.lineTo(sx(0), this.canvas.height); }
    if (b.minZ <= 0 && b.maxZ >= 0) { ctx.moveTo(0, sz(0)); ctx.lineTo(this.canvas.width, sz(0)); }
    ctx.stroke();
  }

  /** Icon size in device pixels: integer multiple of the sprite size. */
  private iconPx(): number { return ICON_SIZE * Math.max(1, Math.round(1.75 * this.dpr)); }

  private drawMarkers(): void {
    const { ctx, dpr, camera: c, view: v } = this;
    const size = this.iconPx(), half = size / 2, pad = half / dpr * c.scale;
    const b = viewBounds(c, v);
    const draw = (m: ViewMarker, chosen: boolean): void => {
      const x = Math.round(((m.x - c.x) / c.scale + v.width / 2) * dpr - half);
      const y = Math.round(((m.z - c.z) / c.scale + v.height / 2) * dpr - half);
      const color = this.styles.get(m.layer) ?? '#e5c379';
      ctx.fillStyle = 'rgba(6,10,8,0.45)';
      ctx.fillRect(x + Math.round(2 * dpr), y + Math.round(2 * dpr), size, size);
      if (chosen) {
        ctx.fillStyle = '#a6d278';
        const r = Math.round(3 * dpr);
        ctx.fillRect(x - r, y - r, size + 2 * r, size + 2 * r);
      }
      ctx.drawImage(iconCanvas(m.layer, color), x, y, size, size);
      ctx.fillStyle = color;
      ctx.fillRect(x + Math.round(size * 0.2), y + size + Math.round(dpr), Math.round(size * 0.6), Math.max(2, Math.round(2 * dpr)));
    };
    for (const m of this.markers) {
      if (m.x < b.minX - pad || m.x > b.maxX + pad || m.z < b.minZ - pad || m.z > b.maxZ + pad) continue;
      if (m.id !== this.selected?.id) draw(m, false);
    }
    if (this.selected) draw(this.selected, true);
  }

  // ---------------------------------------------------------------- tiles
  private schedule(level: number): void {
    const r = tileRange(this.camera, this.view, level, 1), size = tileBlocks(level);
    const strict = tileRange(this.camera, this.view, level, 0);
    const wanted: { tx: number; tz: number; d: number }[] = [];
    let missing = 0;
    const ctx = this.camera.x / size - 0.5, ctz = this.camera.z / size - 0.5;
    for (let tz = r.tz0; tz <= r.tz1; tz++) for (let tx = r.tx0; tx <= r.tx1; tx++) {
      if ((tx + 1) * size <= -WORLD_LIMIT || tx * size >= WORLD_LIMIT || (tz + 1) * size <= -WORLD_LIMIT || tz * size >= WORLD_LIMIT) continue;
      const key = tileKey(level, tx, tz);
      if (this.tiles.has(key) || this.failed.has(key)) continue;
      const onScreen = tx >= strict.tx0 && tx <= strict.tx1 && tz >= strict.tz0 && tz <= strict.tz1;
      if (onScreen) missing++;
      if (!this.inflight.has(key)) wanted.push({ tx, tz, d: (tx - ctx) ** 2 + (tz - ctz) ** 2 + (onScreen ? 0 : 1e6) });
    }
    wanted.sort((a, b) => a.d - b.d);
    for (const w of wanted) {
      if (this.inflight.size >= CONCURRENCY) break;
      this.fetchTile(level, w.tx, w.tz);
    }
    this.evict(level);
    const next: BoardStatus = { ...this.status, missing, loading: this.inflight.size, ready: missing === 0 && this.tiles.size > 0 };
    if (next.missing !== this.status.missing || next.loading !== this.status.loading || next.ready !== this.status.ready) {
      this.status = next;
      this.events.status?.({ ...next });
    }
  }

  private fetchTile(level: number, tx: number, tz: number): void {
    const key = tileKey(level, tx, tz), generation = this.generation, inflight = this.inflight;
    inflight.add(key);
    const started = performance.now();
    this.source(tileRegion(level, tx, tz)).then(frame => {
      if (generation !== this.generation) return;
      this.tiles.set(key, { key, level, tx, tz, biomes: frame.biomes, names: frame.names, image: paintTile(frame), used: performance.now() });
      this.status = { ...this.status, backend: frame.backend, lastMs: performance.now() - started };
    }, (reason: unknown) => {
      if (generation !== this.generation) return;
      this.failed.add(key);
      this.events.error?.(reason instanceof Error ? reason : new Error(String(reason)));
    }).finally(() => {
      inflight.delete(key);
      if (generation === this.generation) this.invalidate();
    });
  }

  private evict(level: number): void {
    if (this.tiles.size <= MAX_TILES) return;
    const keep = tileRange(this.camera, this.view, level, 1);
    const candidates = [...this.tiles.values()]
      .filter(t => t.level !== level || t.tx < keep.tx0 || t.tx > keep.tx1 || t.tz < keep.tz0 || t.tz > keep.tz1)
      .sort((a, b) => a.used - b.used);
    for (const t of candidates) {
      if (this.tiles.size <= MAX_TILES) break;
      this.tiles.delete(t.key);
    }
  }

  private biomeAt(bx: number, bz: number): string | null {
    const level = levelFor(this.camera.scale);
    for (const l of [level, level - 1, level + 1, level - 2, level + 2, level + 3]) {
      if (l < 0) continue;
      const size = tileBlocks(l), tx = Math.floor(bx / size), tz = Math.floor(bz / size);
      const tile = this.tiles.get(tileKey(l, tx, tz));
      if (!tile) continue;
      const cell = size / TILE;
      const i = Math.floor((bx - tx * size) / cell), j = Math.floor((bz - tz * size) / cell);
      const id = tile.biomes[j * TILE + i];
      return id === undefined ? null : tile.names[id] ?? `biome ${id}`;
    }
    return null;
  }

  // ---------------------------------------------------------------- input
  private local(e: PointerEvent | WheelEvent): [number, number] {
    return [e.clientX - this.rect.left, e.clientY - this.rect.top];
  }
  private markerAt(sx: number, sy: number): ViewMarker | null {
    const c = this.camera, v = this.view, half = this.iconPx() / this.dpr / 2 + 3;
    let best: ViewMarker | null = null, bestD = Infinity;
    for (const m of this.markers) {
      const mx = (m.x - c.x) / c.scale + v.width / 2, my = (m.z - c.z) / c.scale + v.height / 2;
      const dx = Math.abs(mx - sx), dy = Math.abs(my - sy);
      if (dx <= half && dy <= half && dx + dy < bestD) { best = m; bestD = dx + dy; }
    }
    return best;
  }
  private readonly onDown = (e: PointerEvent): void => {
    if (e.button > 0) return;
    this.rect = this.canvas.getBoundingClientRect();
    // Capture is an enhancement; it throws for pointers the UA does not track.
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* keep handling */ }
    const [x, y] = this.local(e);
    this.pointers.set(e.pointerId, { x, y });
    if (this.pointers.size === 1) {
      this.gesture = { kind: 'drag', id: e.pointerId, sx: x, sy: y, x: this.camera.x, z: this.camera.z, moved: false };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const [wx, wz] = screenToWorld(this.camera, this.view, (a.x + b.x) / 2, (a.y + b.y) / 2);
      this.gesture = { kind: 'pinch', dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale: this.camera.scale, wx, wz };
    }
  };
  private readonly onMove = (e: PointerEvent): void => {
    const [x, y] = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });
    const g = this.gesture;
    if (g?.kind === 'drag' && g.id === e.pointerId) {
      if (!g.moved && Math.hypot(x - g.sx, y - g.sy) < 4) return;
      g.moved = true;
      this.setCamera({ x: g.x - (x - g.sx) * this.camera.scale, z: g.z - (y - g.sy) * this.camera.scale });
      return;
    }
    if (g?.kind === 'pinch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const scale = clampScale(g.scale * g.dist / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.setCamera({ scale, x: g.wx - (mx - this.view.width / 2) * scale, z: g.wz - (my - this.view.height / 2) * scale });
      return;
    }
    if (!g && e.pointerType === 'mouse') {
      const [bx, bz] = screenToWorld(this.camera, this.view, x, y);
      const ix = Math.floor(bx), iz = Math.floor(bz);
      this.events.hover?.({ x: ix, z: iz, biome: this.biomeAt(ix, iz) });
      this.canvas.style.cursor = this.markerAt(x, y) ? 'pointer' : '';
    }
  };
  private readonly onUp = (e: PointerEvent): void => {
    const g = this.gesture;
    this.pointers.delete(e.pointerId);
    if (g?.kind === 'drag' && g.id === e.pointerId) {
      this.gesture = null;
      if (!g.moved && e.type === 'pointerup') {
        const [x, y] = this.local(e);
        const hit = this.markerAt(x, y);
        this.select(hit);
        this.events.select?.(hit);
      }
      this.scheduleSettle();
    } else if (g?.kind === 'pinch' && this.pointers.size < 2) {
      // Continue as a drag with the remaining finger, from its current position.
      const rest = [...this.pointers.entries()][0];
      this.gesture = rest ? { kind: 'drag', id: rest[0], sx: rest[1].x, sy: rest[1].y, x: this.camera.x, z: this.camera.z, moved: true } : null;
      this.scheduleSettle();
    }
  };
  private readonly onLeave = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && !this.gesture) this.events.hover?.(null);
  };
  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.rect = this.canvas.getBoundingClientRect();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    const [x, y] = this.local(e);
    this.zoomBy(Math.exp(Math.max(-300, Math.min(300, delta)) * 0.002), x, y);
  };
}

const palettes = new WeakMap<string[], Uint32Array>();
function paletteFor(names: string[]): Uint32Array {
  let p = palettes.get(names);
  if (!p) {
    p = new Uint32Array(names.length);
    // ImageData is RGBA in memory: pack as little-endian ABGR.
    names.forEach((name, i) => {
      const rgb = biomeColor(name);
      p![i] = 0xff000000 | ((rgb & 255) << 16) | (rgb & 0xff00) | (rgb >>> 16);
    });
    palettes.set(names, p);
  }
  return p;
}
function paintTile(frame: ViewFrame): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE;
  const image = new ImageData(TILE, TILE);
  const out = new Uint32Array(image.data.buffer), palette = paletteFor(frame.names);
  for (let i = 0; i < out.length; i++) out[i] = palette[frame.biomes[i]!] ?? 0xff40453c;
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  return canvas;
}

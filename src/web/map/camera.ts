// Pure camera / tile-grid math for the map board. No DOM access.
//
// Camera: centre in block coordinates (float) and `scale` in blocks per CSS
// pixel. Biome tiles are world-aligned: a tile at level L samples every 2^L
// quarts, TILE samples per side, so tile (tx, tz) always covers the same blocks
// regardless of where the camera was when it was requested. That alignment is
// what keeps tiles and structure markers from drifting after a pan.

export const TILE = 256;
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 512;
export const WORLD_LIMIT = 30_000_000;

export interface Camera { x: number; z: number; scale: number }
export interface Viewport { width: number; height: number }
export interface TileRange { level: number; tx0: number; tz0: number; tx1: number; tz1: number }

export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
export const clampCoord = (v: number): number => Math.min(WORLD_LIMIT, Math.max(-WORLD_LIMIT, v));

/** Quarts per sample is 2^level; aims for roughly 2 CSS px per sample. */
export function levelFor(scale: number): number {
  return Math.max(0, Math.round(Math.log2(clampScale(scale) / 2)));
}
export const stepOf = (level: number): number => 2 ** level;
/** Side length of one biome tile in blocks. */
export const tileBlocks = (level: number): number => TILE * stepOf(level) * 4;

export function worldToScreen(c: Camera, v: Viewport, bx: number, bz: number): [number, number] {
  return [(bx - c.x) / c.scale + v.width / 2, (bz - c.z) / c.scale + v.height / 2];
}
export function screenToWorld(c: Camera, v: Viewport, sx: number, sy: number): [number, number] {
  return [c.x + (sx - v.width / 2) * c.scale, c.z + (sy - v.height / 2) * c.scale];
}

/** Half-open block bounds of the viewport. */
export function viewBounds(c: Camera, v: Viewport): { minX: number; minZ: number; maxX: number; maxZ: number } {
  const [minX, minZ] = screenToWorld(c, v, 0, 0), [maxX, maxZ] = screenToWorld(c, v, v.width, v.height);
  return { minX, minZ, maxX, maxZ };
}

/** Inclusive tile index range covering the viewport (plus `margin` tiles). */
export function tileRange(c: Camera, v: Viewport, level: number, margin = 0): TileRange {
  const size = tileBlocks(level), b = viewBounds(c, v);
  return {
    level,
    tx0: Math.floor(b.minX / size) - margin, tz0: Math.floor(b.minZ / size) - margin,
    tx1: Math.floor(b.maxX / size) + margin, tz1: Math.floor(b.maxZ / size) + margin,
  };
}

/** Quart region sampled for tile (tx, tz) at `level`. */
export function tileRegion(level: number, tx: number, tz: number): { x0: number; z0: number; w: number; h: number; step: number } {
  const step = stepOf(level);
  return { x0: tx * TILE * step, z0: tz * TILE * step, w: TILE, h: TILE, step };
}

/** Keep the world point under (sx, sy) fixed while changing scale. */
export function zoomAt(c: Camera, v: Viewport, sx: number, sy: number, nextScale: number): Camera {
  const scale = clampScale(nextScale);
  const [wx, wz] = screenToWorld(c, v, sx, sy);
  return {
    x: clampCoord(wx - (sx - v.width / 2) * scale),
    z: clampCoord(wz - (sy - v.height / 2) * scale),
    scale,
  };
}

/** Grid spacing in blocks: a power of two ≥ 16 (one chunk) at least `minPx` apart. */
export function gridSpacing(scale: number, minPx = 40): number {
  let s = 16;
  while (s / scale < minPx) s *= 2;
  return s;
}

/** Round "nice" scale-bar length (1/2/5 × 10^n blocks) not exceeding `maxPx`. */
export function scaleBar(scale: number, maxPx: number): { blocks: number; pixels: number } {
  const wanted = scale * maxPx;
  const power = 10 ** Math.floor(Math.log10(Math.max(1, wanted)));
  const blocks = [5, 2, 1].map(n => n * power).find(n => n <= wanted) ?? power;
  return { blocks, pixels: blocks / scale };
}

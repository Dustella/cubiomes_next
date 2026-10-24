import { describe, expect, test } from 'bun:test';
import {
  TILE, gridSpacing, levelFor, scaleBar, screenToWorld, tileBlocks, tileRange, tileRegion,
  viewBounds, worldToScreen, zoomAt,
} from '../src/web/map/camera';
import { ICON_SIZE, SPRITES, iconKey, spritePixels } from '../src/web/map/icons';

const view = { width: 1000, height: 600 };

describe('map camera', () => {
  test('screen/world round trip', () => {
    const c = { x: 1234.5, z: -987.25, scale: 3 };
    const [wx, wz] = screenToWorld(c, view, 137, 451);
    const [sx, sy] = worldToScreen(c, view, wx, wz);
    expect(sx).toBeCloseTo(137, 9);
    expect(sy).toBeCloseTo(451, 9);
    expect(screenToWorld(c, view, 500, 300)).toEqual([c.x, c.z]);
  });

  test('zoomAt keeps the anchored world point under the cursor', () => {
    const c = { x: 100, z: 200, scale: 4 };
    const before = screenToWorld(c, view, 820, 75);
    const next = zoomAt(c, view, 820, 75, 1);
    const after = screenToWorld(next, view, 820, 75);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
  });

  test('drag pan is exact: total screen delta × scale, no rounding drift', () => {
    let c = { x: 0, z: 0, scale: 7.3 };
    const start = { ...c };
    // Same drag delivered as many small moves resolves to the same camera.
    for (let i = 1; i <= 50; i++) c = { ...c, x: start.x - i * 3 * c.scale, z: start.z - i * -2 * c.scale };
    expect(c.x).toBeCloseTo(-150 * 7.3, 9);
    expect(c.z).toBeCloseTo(100 * 7.3, 9);
  });

  test('levels aim for about 2 px per sample', () => {
    expect(levelFor(0.25)).toBe(0);
    expect(levelFor(4)).toBe(1);
    expect(levelFor(8)).toBe(2);
    expect(levelFor(64)).toBe(5);
  });

  test('tiles are world-aligned and tile the plane exactly', () => {
    for (const level of [0, 3, 7]) {
      const size = tileBlocks(level);
      const a = tileRegion(level, -1, 2), b = tileRegion(level, 0, 2);
      expect(a.w).toBe(TILE);
      // Adjacent tiles share an edge with no gap or overlap, in quarts.
      expect(a.x0 + a.w * a.step).toBe(b.x0);
      expect(b.x0 * 4).toBe(0);
      expect(a.z0 * 4).toBe(2 * size);
    }
  });

  test('tile range covers the viewport regardless of camera offset', () => {
    const c = { x: -5000.7, z: 3333.3, scale: 5 };
    const level = levelFor(c.scale), size = tileBlocks(level), r = tileRange(c, view, level), b = viewBounds(c, view);
    expect(r.tx0 * size).toBeLessThanOrEqual(b.minX);
    expect((r.tx1 + 1) * size).toBeGreaterThan(b.maxX);
    expect(r.tz0 * size).toBeLessThanOrEqual(b.minZ);
    expect((r.tz1 + 1) * size).toBeGreaterThan(b.maxZ);
  });

  test('grid and scale bar helpers', () => {
    expect(gridSpacing(0.25)).toBe(16);
    expect(gridSpacing(8) / 8).toBeGreaterThanOrEqual(40);
    const bar = scaleBar(8, 110);
    expect([1, 2, 5]).toContain(bar.blocks / 10 ** Math.floor(Math.log10(bar.blocks)));
    expect(bar.pixels).toBeLessThanOrEqual(110);
  });
});

describe('structure icons', () => {
  test('every sprite is a valid 12×12 grid over the palette', () => {
    for (const key of Object.keys(SPRITES)) {
      const rows = SPRITES[key]!;
      expect(rows.length).toBe(ICON_SIZE);
      for (const row of rows) expect(row.length).toBe(ICON_SIZE);
      const px = spritePixels(key, '#123456');
      expect(px.length).toBe(ICON_SIZE * ICON_SIZE * 4);
      expect(px.some((v, i) => i % 4 === 3 && v === 255)).toBe(true);
    }
  });

  test('both structure paths resolve to dedicated icons', () => {
    const cubiomes = ['desert_pyramid', 'jungle_temple', 'swamp_hut', 'igloo', 'village', 'ocean_ruin', 'shipwreck',
      'monument', 'mansion', 'outpost', 'ruined_portal', 'ruined_portal_nether', 'ancient_city', 'buried_treasure',
      'mineshaft', 'desert_well', 'geode', 'fortress', 'bastion', 'end_city', 'end_gateway', 'end_island',
      'trail_ruins', 'trial_chambers', 'stronghold'];
    const sets = ['ancient_cities', 'buried_treasures', 'desert_pyramids', 'end_cities', 'igloos', 'jungle_temples',
      'mineshafts', 'nether_complexes', 'nether_fossils', 'ocean_monuments', 'ocean_ruins', 'pillager_outposts',
      'ruined_portals', 'shipwrecks', 'strongholds', 'swamp_huts', 'trail_ruins', 'trial_chambers', 'villages',
      'woodland_mansions'].map(id => `minecraft:${id}`);
    for (const id of [...cubiomes, ...sets]) expect(iconKey(id)).not.toBe('generic');
    expect(iconKey('feature')).toBe('generic');
  });

  test('generic icon takes the layer tint', () => {
    const px = spritePixels('generic', '#ff0080');
    let found = false;
    for (let i = 0; i < px.length; i += 4) if (px[i] === 255 && px[i + 1] === 0 && px[i + 2] === 128) found = true;
    expect(found).toBe(true);
  });
});

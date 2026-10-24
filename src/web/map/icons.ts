// Original 12×12 pixel-art structure icons drawn for this project (no game or
// third-party assets). Each row is one string; each character is a palette key.
// '.' is transparent and 'x' is replaced by the layer's tint colour.

export const ICON_SIZE = 12;

const PALETTE: Record<string, number> = {
  k: 0x1a1a1a, w: 0xf2f2f2, y: 0xe8c872, Y: 0xb8913e, g: 0x5fa83c, G: 0x2f6b25,
  b: 0x8a5a32, B: 0x5a3a1e, s: 0x9a9a9a, S: 0x5e5e5e, c: 0x4fd1c5, C: 0x2a8f86,
  p: 0xb07cd8, P: 0x4a2a6a, r: 0xd4433a, R: 0x8c2420, o: 0xf0a030, l: 0x9fd4ff,
  n: 0x2a4a8a, m: 0xa040e0, q: 0xe8e6b0, d: 0x3a3f4a, D: 0x0f5a66, e: 0x3fa07a,
};

export const SPRITES: Readonly<Record<string, readonly string[]>> = {
  village: [
    '.....kk.....', '....krrk....', '...krrrrk...', '..krrrrrrk..', '.krrrrrrrrk.', 'kkkkkkkkkkkk',
    '.kbbbbbbbbk.', '.kbllbbllbk.', '.kbllbbllbk.', '.kbbbBBbbbk.', '.kbbbBBbbbk.', '.kkkkkkkkkk.',
  ],
  desert_pyramid: [
    '............', '.....kk.....', '....kyyk....', '...kyyyYk...', '...kyoyYk...', '..kyyyyyYk..',
    '..kyyyyyYk..', '.kyyyyyyyYk.', '.kyykkkyyYk.', 'kyyykBkyyyYk', 'kkkkkkkkkkkk', '............',
  ],
  jungle_temple: [
    '............', '....kkkk....', '....kgGk....', '..kkkkkkkk..', '..ksgsSsgk..', '..kssGsssk..',
    'kkkkkkkkkkkk', 'ksgssGssgssk', 'kssSskkssSsk', 'kgssk..ksgsk', 'ksssk..kssGk', 'kkkkkkkkkkkk',
  ],
  swamp_hut: [
    '..kkkkkkkk..', '.kBBBBBBBBk.', 'kBBBBBBBBBBk', 'kkkkkkkkkkkk', '.kbbbbbbbbk.', '.kbbkpkbbbk.',
    '.kbbbbbbbbk.', '.kkkkkkkkkk.', '..kB....Bk..', '..kB....Bk..', '..kB....Bk..', 'nnnnnnnnnnnn',
  ],
  igloo: [
    '............', '............', '....kkkk....', '..kkwwwwkk..', '.kwwwwwwwwk.', '.kwlwwwwlwk.',
    'kwwwwwwwwwwk', 'kwwwwkkwwwwk', 'kwlwk..kwlwk', 'kwwwk..kwwwk', 'kkkkkkkkkkkk', '............',
  ],
  ocean_ruin: [
    '............', '.kkkkkk.....', '.kssSsk.....', '.kkkkkk.kkk.', '..ksk...ksk.', '..kSk...kSk.',
    '..ksk...ksk.', '..kSk...ksk.', '..ksk...kSk.', '.kkkkk.kkkkk', 'nnnnnnnnnnnn', 'nlnnnlnnnnln',
  ],
  shipwreck: [
    '......k.....', '......kwk...', '......kwwk..', '......kwwwk.', '......kkkkk.', '......kB....',
    'kk....kB...k', 'kbkkkkkkkkbk', '.kbbbbbbbbk.', '..kBBBBBBk..', 'nnnkkkkkknnn', 'nlnnnnnnnnln',
  ],
  monument: [
    '............', '.....kk.....', '....kcck....', '...kcCCck...', '..kkkkkkkk..', '..kcCccCck..',
    '.kkkkkkkkkk.', '.kcCcCCcCck.', 'kkkkkkkkkkkk', 'kcCcckkcCcck', 'kccCk..kCcck', 'kkkkkkkkkkkk',
  ],
  mansion: [
    'kk...kk...kk', 'kBk.kBBk.kBk', 'kBkkkBBkkkBk', 'kbBbbbbbbBbk', 'kbobbobbobbk', 'kbbbbbbbbbbk',
    'kBBBBBBBBBBk', 'kbobbobbobbk', 'kbbbbkkbbbbk', 'kbobk..kbobk', 'kbbbk..kbbbk', 'kkkkkkkkkkkk',
  ],
  outpost: [
    '...kkkkkk...', '...kBBBBk...', '..kkkkkkkk..', '...kbbbbk...', '...kbkkbk...', '...kBbbBk...',
    '...kbbbbk...', '...kbwwbk...', '...kbwSbk...', '...kbbbbk...', '..kkbkkbkk..', '..kkkkkkkk..',
  ],
  ruined_portal: [
    '..kkkkk.....', '..kPPPk.kk..', '..kPkkkkPk..', '..kPkmmkPk..', '..kPkmmkPk..', '..kPkmmkPk..',
    '..kPkmmkPk..', '..kPkkkkPk..', '..kPPPPPPk..', '..kkkkkkkk..', '.kssk..kssk.', '............',
  ],
  ancient_city: [
    '............', 'kkkkkkkkkkkk', 'kddddddddddk', 'kdkkkkkkkkdk', 'kdkDDDDDDkdk', 'kdkDcDDcDkdk',
    'kdkDDDDDDkdk', 'kdkDDccDDkdk', 'kdkkkkkkkkdk', 'kddddddddddk', 'kddkddddkddk', 'kkkkkkkkkkkk',
  ],
  buried_treasure: [
    '............', '............', '.kkkkkkkkkk.', '.kbbbbbbbbk.', '.kbBBBBBBbk.', 'kkkkkkkkkkkk',
    'kbbbbkkbbbbk', 'kbbbkyykbbbk', 'kbbbbkkbbbbk', 'kBbbbbbbbbBk', 'kkkkkkkkkkkk', '............',
  ],
  mineshaft: [
    '............', 'kkkkkkkkkkkk', 'kbbbbbbbbbbk', 'kkkkkkkkkkkk', '.kbkddddkbk.', '.kbkddddkbk.',
    '.kbkddddkbk.', '.kbkddddkbk.', '.kbkddddkbk.', '.kbkddddkbk.', 'kSSSSSSSSSSk', 'kbkbkbkbkbkb',
  ],
  desert_well: [
    '............', '..kkkkkkkk..', '..kYYYYYYk..', '..kkkkkkkk..', '...ky..yk...', '...ky..yk...',
    '...ky..yk...', 'kkkkkkkkkkkk', 'kyyknnnnkyyk', 'kyyklllnkyyk', 'kYYYYYYYYYYk', 'kkkkkkkkkkkk',
  ],
  geode: [
    '....kkkk....', '..kkwwwwkk..', '.kwwkkkkwwk.', '.kwkpPppkwk.', 'kwkpPpppPkwk', 'kwkpppPppkwk',
    'kwkPppppPkwk', 'kwkppPpppkwk', '.kwkpppPkwk.', '.kwwkkkkwwk.', '..kkwwwwkk..', '....kkkk....',
  ],
  trail_ruins: [
    '............', '....kkkk....', '....kbbk....', '...kkkkkk...', '..kooooook..', '.kooBooBook.',
    '.kooooooook.', '.koBBooBBok.', '.kooooooook.', '..kooooook..', '...kkkkkk...', '............',
  ],
  trial_chambers: [
    'kkkkkkkkkkkk', 'kSSkSSSSkSSk', 'kkkkkkkkkkkk', 'kddkddddkddk', 'kddkdoodkddk', 'kddkooookddk',
    'kddkorrokddk', 'kddkooookddk', 'kddkddddkddk', 'kkkkkkkkkkkk', 'kSSkSSSSkSSk', 'kkkkkkkkkkkk',
  ],
  fortress: [
    'kkk.kkkk.kkk', 'kRk.kRRk.kRk', 'kRkkkRRkkkRk', 'kRRRRRRRRRRk', 'krRRrRRrRRrk', 'kRRRRRRRRRRk',
    'kkkkkkkkkkkk', '.kRk....kRk.', '.kRk....kRk.', '.kRk....kRk.', '.kRk....kRk.', '.kkk....kkk.',
  ],
  bastion: [
    'kkkk....kkkk', 'kddk....kddk', 'kddkkkkkkddk', 'kddddddddddk', 'kddkddddkddk', 'kdddyyyydddk',
    'kddyykkyyddk', 'kdddyyyydddk', 'kddddddddddk', 'kddkkddkkddk', 'kddk....kddk', 'kkkk....kkkk',
  ],
  nether_fossil: [
    '............', '.kk......kk.', 'kwwk....kwwk', 'kwwwk..kwwwk', '.kwwwkkwwwk.', '..kwwwwwwk..',
    '..kwwwwwwk..', '.kwwwkkwwwk.', 'kwwwk..kwwwk', 'kwwk....kwwk', '.kk......kk.', '............',
  ],
  end_city: [
    '.....kk.....', '....kppk....', '...kkkkkk...', '....kppk....', '..kkkkkkkk..', '..kpPppPpk..',
    '...kpppPk...', '.kkkkkkkkkk.', '.kpPppppPpk.', '..kppkkppk..', '..kpk..kpk..', '..kkk..kkk..',
  ],
  end_gateway: [
    '.....mm.....', '.....mm.....', '..kkkkkkkk..', '..kSSSSSSk..', '..kSkkkkSk..', '..kSkmmkSk..',
    '..kSkmmkSk..', '..kSkkkkSk..', '..kSSSSSSk..', '..kkkkkkkk..', '.....mm.....', '.....mm.....',
  ],
  end_island: [
    '............', '............', '....kkkk....', '..kkqqqqkk..', '.kqqqqqqqqk.', 'kqqYqqqqqqqk',
    'kqqqqqqqYqqk', '.kqqqqqqqqk.', '..kkqqqqkk..', '....kkkk....', '............', '............',
  ],
  stronghold: [
    '............', '....kkkk....', '..kkeeeekk..', '.keeeeeeeek.', '.keeekkeeek.', 'keeekGGkeeek',
    'keeekGGkeeek', '.keeekkeeek.', '.keeeeeeeek.', '..kkeeeekk..', '....kkkk....', '............',
  ],
  generic: [
    '.....kk.....', '....kxxk....', '...kxxxxk...', '..kxxwxxxk..', '.kxxwxxxxxk.', 'kxxxxxxxxxxk',
    'kxxxxxxxxxxk', '.kxxxxxxxxk.', '..kxxxxxxk..', '...kxxxxk...', '....kxxk....', '.....kk.....',
  ],
};

/** Layer ids from both structure paths (Cubiomes kinds and 26.2 structure sets). */
const ALIASES: Record<string, string> = {
  ancient_cities: 'ancient_city', buried_treasures: 'buried_treasure', desert_pyramids: 'desert_pyramid',
  end_cities: 'end_city', igloos: 'igloo', jungle_temples: 'jungle_temple', mineshafts: 'mineshaft',
  nether_complexes: 'fortress', nether_fossils: 'nether_fossil', ocean_monuments: 'monument',
  ocean_ruins: 'ocean_ruin', pillager_outposts: 'outpost', ruined_portals: 'ruined_portal',
  ruined_portal_nether: 'ruined_portal', shipwrecks: 'shipwreck', strongholds: 'stronghold',
  swamp_huts: 'swamp_hut', villages: 'village', woodland_mansions: 'mansion',
};

export function iconKey(layerId: string): string {
  const id = layerId.replace(/^minecraft:/, '');
  const key = ALIASES[id] ?? id;
  return Object.hasOwn(SPRITES, key) ? key : 'generic';
}

function parseHex(color: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  return m ? parseInt(m[1]!, 16) : 0xe5c379;
}

/** RGBA pixels (ICON_SIZE² × 4). Pure; usable in tests without a DOM. */
export function spritePixels(key: string, tint = '#e5c379'): Uint8ClampedArray {
  const rows = SPRITES[key] ?? SPRITES.generic!;
  const out = new Uint8ClampedArray(ICON_SIZE * ICON_SIZE * 4);
  const x = parseHex(tint);
  for (let r = 0; r < ICON_SIZE; r++) {
    for (let c = 0; c < ICON_SIZE; c++) {
      const ch = rows[r]![c]!;
      if (ch === '.') continue;
      const rgb = ch === 'x' ? x : PALETTE[ch];
      if (rgb === undefined) throw new Error(`Unknown palette key "${ch}" in sprite ${key}`);
      const i = (r * ICON_SIZE + c) * 4;
      out[i] = rgb >>> 16; out[i + 1] = (rgb >>> 8) & 255; out[i + 2] = rgb & 255; out[i + 3] = 255;
    }
  }
  return out;
}

const canvases = new Map<string, HTMLCanvasElement>();
/** Native-resolution sprite canvas; draw scaled with imageSmoothingEnabled=false. */
export function iconCanvas(layerId: string, tint: string): HTMLCanvasElement {
  const key = iconKey(layerId), cacheKey = `${key}/${key === 'generic' ? tint : ''}`;
  let canvas = canvases.get(cacheKey);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = canvas.height = ICON_SIZE;
    const pixels = spritePixels(key, tint);
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), ICON_SIZE, ICON_SIZE), 0, 0);
    canvases.set(cacheKey, canvas);
  }
  return canvas;
}

const urls = new Map<string, string>();
/** Data URL for DOM use (layer list, legend). */
export function iconURL(layerId: string, tint: string): string {
  const key = `${iconKey(layerId)}/${tint}`;
  let url = urls.get(key);
  if (!url) { url = iconCanvas(layerId, tint).toDataURL('image/png'); urls.set(key, url); }
  return url;
}

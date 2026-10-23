// Release identifiers follow Cubiomes biomes.h. No game assets or code.
export interface MinecraftVersion {
  readonly id: string;
  readonly mc: number;
  readonly major: string;
}

/** Latest supported patch of each release, plus algorithm-changing patch lines.
 * Major aliases resolve within the strict <1.21.4 cutoff (1.21 means 1.21.3).
 * Beta releases and unlisted patch identifiers are intentionally not inferred.
 */
export const SUPPORTED_VERSIONS: readonly MinecraftVersion[] = Object.freeze(([
  ['1.0.0', 3, '1.0'], ['1.1.0', 4, '1.1'], ['1.2.5', 5, '1.2'],
  ['1.3.2', 6, '1.3'], ['1.4.7', 7, '1.4'], ['1.5.2', 8, '1.5'],
  ['1.6.4', 9, '1.6'], ['1.7.10', 10, '1.7'], ['1.8.9', 11, '1.8'],
  ['1.9.4', 12, '1.9'], ['1.10.2', 13, '1.10'], ['1.11.2', 14, '1.11'],
  ['1.12.2', 15, '1.12'], ['1.13.2', 16, '1.13'], ['1.14.4', 17, '1.14'],
  ['1.15.2', 18, '1.15'], ['1.16.1', 19, '1.16'], ['1.16.5', 20, '1.16'],
  ['1.17.1', 21, '1.17'], ['1.18.2', 22, '1.18'], ['1.19.2', 23, '1.19'],
  ['1.19.4', 24, '1.19'], ['1.20.6', 25, '1.20'],
  ['1.21.1', 26, '1.21'], ['1.21.3', 27, '1.21'],
] satisfies [string, number, string][]).map(([id, mc, major]) => Object.freeze({ id, mc, major })));

const versions = new Map<string, MinecraftVersion>();
for (const v of SUPPORTED_VERSIONS) {
  versions.set(v.id, v);
  versions.set(v.major, v);
}

export function resolveVersion(version: string): MinecraftVersion {
  const resolved = versions.get(version);
  if (!resolved) throw new RangeError(`Unsupported Minecraft version "${version}"; supported releases are 1.0–1.21.3 (strictly below 1.21.4)`);
  return resolved;
}

export type Dimension = 'overworld' | 'nether' | 'end';

/** Cubiomes candidates and partial checks; no result promises full Minecraft generation. */
export interface StructurePosition { x: number; z: number }
export interface StructurePosition3 extends StructurePosition { y: number }
export type StructureStage = 'placement' | 'biome' | 'terrain';
export type StructureTerrain = 'unsupported' | 'not-required' | 'approximate' | 'end-surface';
export interface StructureConfig {
  type: number; supported: boolean; salt: number | null; regionSize: number | null;
  chunkRange: number | null; dimension: number; rarity: number | null;
  biomeSupported: boolean; featureBiomeSupported: boolean; terrain: StructureTerrain;
  variantSupported: boolean; variantRequiresBiome: boolean;
}
export interface StructureCheck {
  supported: boolean; raw: number | null; viable: boolean | null;
}
export interface StructurePlacement {
  regionX: number; regionZ: number; position: StructurePosition;
  biome: StructureCheck | null; terrain: StructureCheck | null;
  /** null means that a requested check is unsupported, not that generation succeeds. */
  accepted: boolean | null;
}
export interface StructureVariant {
  abandoned: boolean; giant: boolean; underground: boolean; airpocket: boolean;
  basement: boolean; cracked: boolean; size: number; start: number; biome: number;
  rotation: number; mirror: number; x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  /** Only listed fields are authoritative; all other fields preserve upstream defaults/sentinels. */
  knownFields: string[];
}
export interface StructureStronghold {
  index: number; ring: number; position: StructurePosition; nextApprox: StructurePosition;
}
export interface StructurePiece {
  name: string; position: StructurePosition3; bb0: StructurePosition3; bb1: StructurePosition3;
  rotation: number; depth: number; type: number;
}
export interface StructureEndIsland extends StructurePosition3 { r: number }
export type StructureRequest =
  | { op: 'catalog' }
  | { op: 'position'; type: number; regionX: number; regionZ: number }
  | { op: 'scan'; type: number; regionX: number; regionZ: number; width: number; height: number; stage?: StructureStage; includeRejected?: boolean; flags?: number }
  | { op: 'check'; type: number; x: number; z: number; flags?: number; terrain?: boolean }
  | { op: 'featureBiome'; type: number; biome: number }
  | { op: 'variant'; type: number; x: number; z: number; biome?: number }
  | { op: 'strongholds'; offset?: number; count?: number }
  | { op: 'pieces'; type: number; chunkX: number; chunkZ: number; maxPieces?: number }
  | { op: 'endIslands'; chunkX: number; chunkZ: number }
  | { op: 'fixedGateways' }
  | { op: 'linkedGateway'; x: number; z: number }
  | { op: 'villageHouses'; chunkX: number; chunkZ: number }
  | { op: 'endChunkEmpty'; chunkX: number; chunkZ: number };
export interface StructureResponseMap {
  catalog: { op: 'catalog'; structures: StructureConfig[] };
  position: { op: 'position'; type: number; supported: boolean; position: StructurePosition | null };
  scan: { op: 'scan'; type: number; supported: boolean; stage: StructureStage; terrainMode: StructureTerrain; records: StructurePlacement[] };
  check: { op: 'check'; type: number; biome: StructureCheck; terrain: StructureCheck | null; terrainMode: StructureTerrain };
  featureBiome: { op: 'featureBiome'; type: number; biome: number; check: StructureCheck };
  variant: { op: 'variant'; type: number; supported: boolean; variant: StructureVariant | null };
  strongholds: { op: 'strongholds'; total: number; firstApprox: StructurePosition; records: StructureStronghold[] };
  pieces: { op: 'pieces'; type: number; supported: boolean; pieces: StructurePiece[] };
  endIslands: { op: 'endIslands'; supported: boolean; islands: StructureEndIsland[]; biome: number | null; biomeViable: boolean | null };
  fixedGateways: { op: 'fixedGateways'; supported: boolean; positions: StructurePosition[] };
  linkedGateway: { op: 'linkedGateway'; supported: boolean; chunk: StructurePosition | null; searchPosition: StructurePosition | null; position: StructurePosition | null };
  villageHouses: { op: 'villageHouses'; supported: boolean; counts: number[]; rngState: string | null };
  endChunkEmpty: { op: 'endChunkEmpty'; supported: boolean; empty: boolean | null; bounds: { minX: number; minZ: number; maxX: number; maxZ: number } };
}
export type StructureResponse = StructureResponseMap[keyof StructureResponseMap];
export type StructureResponseFor<R extends StructureRequest> = StructureResponseMap[R['op']];

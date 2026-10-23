import type { WorldgenBundle } from '../core/bundle';

export type BundleDimension = 'overworld' | 'nether' | 'end';
export type BundleFrequencyMethod = 'default' | 'legacy_type_1' | 'legacy_type_2' | 'legacy_type_3';
export interface BundlePlacementBase {
  salt: number;
  locateOffset: [number, number, number];
  frequency: number;
  frequencyReductionMethod: BundleFrequencyMethod;
  exclusionZone?: { otherSet: string; chunkCount: number };
}
export interface BundleRandomSpreadPlacement extends BundlePlacementBase {
  type: 'random_spread'; spacing: number; separation: number; spreadType: 'linear' | 'triangular';
}
export interface BundleConcentricRingsPlacement extends BundlePlacementBase {
  type: 'concentric_rings'; distance: number; spread: number; count: number; preferredBiomes: string[];
}
export type BundlePlacement = BundleRandomSpreadPlacement | BundleConcentricRingsPlacement;
export interface BundleStructureDefinition { id: string; type: string; allowedBiomes: string[] }
export interface BundleStructureSet { id: string; placement: BundlePlacement; structures: { structure: string; weight: number }[] }
export interface StructureBundle {
  format: 'structure-bundle-1'; version: '26.2'; biomes: WorldgenBundle;
  structures: Record<string, BundleStructureDefinition>;
  sets: Record<string, BundleStructureSet>;
  /** Preset ID to dimension-specific key in biomes.dimensions. */
  presets: Record<string, Partial<Record<BundleDimension, string>>>;
}
export type BundleStructureRequest =
  | { op: 'catalog' }
  | { op: 'position'; set: string; regionX: number; regionZ: number }
  | { op: 'scan'; set: string; regionX: number; regionZ: number; width: number; height: number }
  | { op: 'rings'; set?: string; offset?: number; count?: number }
  | { op: 'biome'; structure: string; qx: number; qy: number; qz: number };
export interface BundleStructureCapabilities {
  randomSpread: true; frequency: true; exclusion: true; weightedAttemptOrder: true;
  pointBiomeEligibility: true; concentricRings: 'preferred-biome-adjusted';
  generationStarts: false; terrain: false; pieces: false;
}
export interface BundleCatalogResponse {
  op: 'catalog'; version: '26.2'; dimension: BundleDimension; preset: string;
  capabilities: BundleStructureCapabilities;
  sets: (BundleStructureSet & { activeStructures: { structure: string; weight: number }[] })[];
  structures: (BundleStructureDefinition & { active: boolean })[];
}
export interface BundlePosition {
  chunkX: number; chunkZ: number; blockX: number; blockZ: number;
  locateX: number; locateY: number; locateZ: number;
}
export interface BundlePlacementCandidate extends BundlePosition {
  regionX: number; regionZ: number;
  initialCandidatePass: true;
  frequencyPass: boolean;
  exclusionPass: boolean | null;
  dimensionPass: boolean;
  placementPass: boolean;
  /**
   * Empty when placement fails; otherwise a retry order assuming every earlier
   * start fails. Preserves all weights, including dimension-ineligible entries.
   * Not a final structure choice; catalog.structures[].active reports dimension eligibility.
   */
  attemptOrder: string[];
}
export interface BundlePositionResponse { op: 'position'; set: string; candidate: BundlePlacementCandidate }
export interface BundleScanResponse { op: 'scan'; set: string; regionX: number; regionZ: number; width: number; height: number; candidates: BundlePlacementCandidate[] }
export interface BundleRingsResponse { op: 'rings'; set: string; total: number; offset: number; positions: BundlePosition[]; adjustment: 'preferred-biome'; dimensionPass: boolean }
export interface BundleBiomeResponse {
  op: 'biome'; structure: string; qx: number; qy: number; qz: number;
  biome: string; eligible: boolean; dimensionPass: boolean;
  scope: 'explicit-quart-point-not-generation-start';
}
export type BundleStructureResponse = BundleCatalogResponse | BundlePositionResponse | BundleScanResponse | BundleRingsResponse | BundleBiomeResponse;
export type BundleStructureResponseFor<R extends BundleStructureRequest> = Extract<BundleStructureResponse, { op: R['op'] }>;

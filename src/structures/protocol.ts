import type { StructureRequest, StructureResponse } from './types';
import type { BundleDimension, BundleStructureRequest, BundleStructureResponse, StructureBundle } from './bundle-schema';

export interface WorkerWorld {
  mc: number;
  seed: bigint;
  largeBiomes: boolean;
}
export type StructureWorkerPayload =
  | { kind: 'initialize'; world: WorkerWorld; wasm: string | ArrayBuffer | WebAssembly.Module }
  | { kind: 'execute'; request: StructureRequest }
  | { kind: 'initializeBundle'; world: { seed: bigint; dimension: BundleDimension; preset: string }; bundle: string | StructureBundle }
  | { kind: 'executeBundle'; request: BundleStructureRequest };
export type StructureWorkerMessage = StructureWorkerPayload & { id: number };
export type StructureWorkerReply =
  | { id: number; ok: true; kind: 'initialized' }
  | { id: number; ok: true; kind: 'result'; result: StructureResponse }
  | { id: number; ok: true; kind: 'bundleInitialized'; version: string }
  | { id: number; ok: true; kind: 'bundleResult'; result: BundleStructureResponse }
  | { id: number; ok: false; name: string; message: string; fatal?: boolean };

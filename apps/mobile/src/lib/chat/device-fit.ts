import { STORAGE_HEADROOM_BYTES } from './gguf-records';

export type DeviceFit = 'fits' | 'tight' | 'tooLarge' | 'noStorage';

export type DeviceBudget = {
  /** Null when the platform does not report it; nothing is then judged on memory. */
  readonly memoryBytes: number | null;
  readonly freeBytes: number;
};

const MIB = 1024 * 1024;

/**
 * The weights load whole, and a 4096-token context, the compute buffers and
 * llama.cpp itself come on top. A rough upper bound, not a measurement.
 */
const RUNTIME_OVERHEAD = 0.15;
const RUNTIME_BYTES = 300 * MIB;

/**
 * The share of physical memory one app can hold before the system ends it.
 * iOS gives a foreground app about half of it without the increased-memory
 * entitlement; Android's limit is looser, so the same bounds are safe there.
 */
const COMFORTABLE_SHARE = 0.45;
const TIGHT_SHARE = 0.65;

/** Bytes per weight of a Q4_K_M file, the usual smallest quantization worth running. */
const Q4_BYTES_PER_PARAMETER = 0.6;

export function estimatedMemoryBytes(downloadBytes: number): number {
  return Math.round(downloadBytes * (1 + RUNTIME_OVERHEAD) + RUNTIME_BYTES);
}

/** Whether a model of this download size runs here: memory decides, storage can veto. */
export function deviceFit(downloadBytes: number, budget: DeviceBudget): DeviceFit | undefined {
  if (budget.freeBytes < downloadBytes + STORAGE_HEADROOM_BYTES) {
    return 'noStorage';
  }
  if (budget.memoryBytes === null) {
    return undefined;
  }
  const memory = estimatedMemoryBytes(downloadBytes);
  if (memory <= budget.memoryBytes * COMFORTABLE_SHARE) {
    return 'fits';
  }
  return memory <= budget.memoryBytes * TIGHT_SHARE ? 'tight' : 'tooLarge';
}

/** Whether the device is known to run this file: an unjudged fit is not a fit. */
export function fitsDevice(fit: DeviceFit | undefined): boolean {
  return fit === 'fits' || fit === 'tight';
}

/**
 * The largest parameter count whose Q4_K_M file still fits, tightly, in memory.
 * Only a first filter: Hugging Face can state the count of a draft model the
 * repository also holds, so the real file sizes decide the fit.
 */
export function maxParametersFor(memoryBytes: number): number {
  const download = (memoryBytes * TIGHT_SHARE - RUNTIME_BYTES) / (1 + RUNTIME_OVERHEAD);
  return Math.max(0, download / Q4_BYTES_PER_PARAMETER);
}

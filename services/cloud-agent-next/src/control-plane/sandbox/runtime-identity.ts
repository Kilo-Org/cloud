import { z } from 'zod';
import {
  KILO_CLI_VERSION_HEADER,
  WRAPPER_VERSION_HEADER,
} from '../../shared/control-plane-runtime-contract.js';
import { safeSandboxRuntimeVersion } from '../../shared/sandbox-status.js';

export const RUNTIME_IDENTITY_KEY = 'allocation_runtime_identity';

const storedRuntimeIdentitySchema = z.object({
  allocationId: z.string(),
  kiloCliVersion: z.unknown(),
  wrapperVersion: z.unknown(),
});

export type RuntimeIdentity = {
  allocationId: string;
  kiloCliVersion: string | null;
  wrapperVersion: string | null;
};

type RuntimeIdentityStorage = {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
};

export type ObservedRuntimeVersions = {
  kiloCliVersion: string | null;
  wrapperVersion: string | null;
};

export function readObservedRuntimeVersions(headers: Headers): ObservedRuntimeVersions {
  return {
    kiloCliVersion: safeSandboxRuntimeVersion(headers.get(KILO_CLI_VERSION_HEADER)),
    wrapperVersion: safeSandboxRuntimeVersion(headers.get(WRAPPER_VERSION_HEADER)),
  };
}

export function readRuntimeIdentity(
  storage: RuntimeIdentityStorage,
  allocationId: string | null
): RuntimeIdentity | null {
  if (allocationId === null) return null;
  const stored = storage.get(RUNTIME_IDENTITY_KEY);
  if (stored === undefined) return null;
  const parsed = storedRuntimeIdentitySchema.safeParse(stored);
  if (!parsed.success || parsed.data.allocationId !== allocationId) return null;
  return {
    allocationId: parsed.data.allocationId,
    kiloCliVersion: safeSandboxRuntimeVersion(parsed.data.kiloCliVersion),
    wrapperVersion: safeSandboxRuntimeVersion(parsed.data.wrapperVersion),
  };
}

export function writeRuntimeIdentity(
  storage: RuntimeIdentityStorage,
  allocationId: string,
  observed: ObservedRuntimeVersions
): void {
  const existing = readRuntimeIdentity(storage, allocationId);
  const kiloCliVersion =
    safeSandboxRuntimeVersion(observed.kiloCliVersion) ?? existing?.kiloCliVersion ?? null;
  const wrapperVersion =
    safeSandboxRuntimeVersion(observed.wrapperVersion) ?? existing?.wrapperVersion ?? null;
  if (kiloCliVersion === null && wrapperVersion === null) {
    storage.delete(RUNTIME_IDENTITY_KEY);
    return;
  }
  storage.put(RUNTIME_IDENTITY_KEY, {
    allocationId,
    kiloCliVersion,
    wrapperVersion,
  } satisfies RuntimeIdentity);
}

export function resetRuntimeIdentity(storage: RuntimeIdentityStorage): void {
  storage.delete(RUNTIME_IDENTITY_KEY);
}

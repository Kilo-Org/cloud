import { withTimeout } from '@kilocode/worker-utils';
import { logger } from './logger.js';
import { deriveSharedSandboxId, isGeneratedSharedSandboxId } from './sandbox-id.js';
import type { SandboxId } from './types.js';

export const SHARED_SANDBOX_FAILOVER_SUFFIX = 'shared-slot-v1';

const SHARED_SANDBOX_ROUTE_KEY_PREFIX = 'shared-sandbox-route:';
const SHARED_SANDBOX_OVERRIDE_TIMEOUT_MS = 5_000;

export type SharedSandboxSuffix = typeof SHARED_SANDBOX_FAILOVER_SUFFIX;

export type SharedSandboxOverrideStore = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

export type SharedSandboxAssignment = {
  sandboxId: SandboxId;
  suffix?: SharedSandboxSuffix;
};

function routeOverrideKey(routeKey: SandboxId): string {
  return `${SHARED_SANDBOX_ROUTE_KEY_PREFIX}${routeKey}`;
}

function readRouteOverride(store: SharedSandboxOverrideStore, key: string): Promise<string | null> {
  return withTimeout(
    store.get(key),
    SHARED_SANDBOX_OVERRIDE_TIMEOUT_MS,
    `Shared sandbox override KV read timed out after ${SHARED_SANDBOX_OVERRIDE_TIMEOUT_MS}ms`
  );
}

function writeRouteOverride(
  store: SharedSandboxOverrideStore,
  key: string,
  value: SharedSandboxSuffix
): Promise<void> {
  return withTimeout(
    store.put(key, value),
    SHARED_SANDBOX_OVERRIDE_TIMEOUT_MS,
    `Shared sandbox override KV write timed out after ${SHARED_SANDBOX_OVERRIDE_TIMEOUT_MS}ms`
  );
}

export async function resolveSharedSandboxAssignment(
  store: SharedSandboxOverrideStore,
  routeKey: SandboxId
): Promise<SharedSandboxAssignment> {
  if (!isGeneratedSharedSandboxId(routeKey)) {
    throw new Error('Shared sandbox route key must be a generated shared sandbox ID');
  }

  const suffix = await readRouteOverride(store, routeOverrideKey(routeKey));
  if (suffix === null) return { sandboxId: routeKey };
  if (suffix !== SHARED_SANDBOX_FAILOVER_SUFFIX) {
    logger
      .withFields({
        routeKey,
        suffix,
        logTag: 'shared_sandbox_override_invalid',
      })
      .error('Rejected invalid shared sandbox override');
    throw new Error('Invalid shared sandbox override');
  }

  return {
    sandboxId: await deriveSharedSandboxId(routeKey, suffix),
    suffix,
  };
}

export async function recordSharedSandboxFailover(
  store: SharedSandboxOverrideStore,
  routeKey: SandboxId
): Promise<void> {
  if (!isGeneratedSharedSandboxId(routeKey)) {
    throw new Error('Shared sandbox route key must be a generated shared sandbox ID');
  }

  const key = routeOverrideKey(routeKey);
  const existing = await readRouteOverride(store, key);
  if (existing === SHARED_SANDBOX_FAILOVER_SUFFIX) return;
  if (existing !== null) {
    throw new Error('Invalid shared sandbox override');
  }
  await writeRouteOverride(store, key, SHARED_SANDBOX_FAILOVER_SUFFIX);
}

import {
  AutoRoutingModeSchema,
  DEFAULT_AUTO_ROUTING_MODE,
  type AutoRoutingMode,
  type AutoRoutingModeOwnerType,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';

type AutoRoutingModeEnv = Pick<Env, 'AUTO_ROUTING_CONFIG'>;

export const AUTO_ROUTING_MODE_CONFIG_PREFIX = 'auto_routing_mode';

const MODE_CACHE_TTL_MS = 60_000;

type CacheEntry = {
  promise: Promise<AutoRoutingMode | null>;
  expiresAt: number;
};

const modeCache = new Map<string, CacheEntry>();

function modeKey(ownerType: AutoRoutingModeOwnerType, ownerId: string): string {
  return `${AUTO_ROUTING_MODE_CONFIG_PREFIX}:${ownerType}:${ownerId}`;
}

async function loadConfiguredMode(
  env: AutoRoutingModeEnv,
  ownerType: AutoRoutingModeOwnerType,
  ownerId: string
): Promise<AutoRoutingMode | null> {
  const key = modeKey(ownerType, ownerId);
  const cached = modeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = env.AUTO_ROUTING_CONFIG.get(key).then(raw => {
    const parsed = AutoRoutingModeSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  });
  const entry = { promise, expiresAt: Date.now() + MODE_CACHE_TTL_MS };
  modeCache.set(key, entry);
  promise.catch(() => {
    if (modeCache.get(key) === entry) {
      modeCache.delete(key);
    }
  });
  return promise;
}

export function clearAutoRoutingModeCache(): void {
  modeCache.clear();
}

export async function getConfiguredAutoRoutingMode(
  env: AutoRoutingModeEnv,
  owner: { ownerType: AutoRoutingModeOwnerType; ownerId: string }
): Promise<AutoRoutingMode | null> {
  return loadConfiguredMode(env, owner.ownerType, owner.ownerId).catch((error: unknown) => {
    console.warn(
      JSON.stringify({
        event: 'auto_routing_config_read_failed',
        key: modeKey(owner.ownerType, owner.ownerId),
        ...formatError(error),
      })
    );
    return null;
  });
}

export async function getAutoRoutingMode(
  env: AutoRoutingModeEnv,
  owner: { userId: string; organizationId: string | null }
): Promise<AutoRoutingMode> {
  if (owner.organizationId) {
    const orgMode = await getConfiguredAutoRoutingMode(env, {
      ownerType: 'org',
      ownerId: owner.organizationId,
    });
    if (orgMode) return orgMode;
  }

  const userMode = await getConfiguredAutoRoutingMode(env, {
    ownerType: 'user',
    ownerId: owner.userId,
  });
  return userMode ?? DEFAULT_AUTO_ROUTING_MODE;
}

export async function setAutoRoutingMode(
  env: AutoRoutingModeEnv,
  owner: { ownerType: AutoRoutingModeOwnerType; ownerId: string },
  mode: AutoRoutingMode | null
): Promise<void> {
  const key = modeKey(owner.ownerType, owner.ownerId);
  if (mode === null) {
    await env.AUTO_ROUTING_CONFIG.delete(key);
  } else {
    await env.AUTO_ROUTING_CONFIG.put(key, mode);
  }
  modeCache.delete(key);
}

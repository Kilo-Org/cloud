import {
  AutoRoutingModeSchema,
  DEFAULT_AUTO_ROUTING_MODE,
  CustomRouterEntriesSchema,
  PersistedEfficientModelPoolSchema,
  type AutoRoutingMode,
  type AutoRoutingModeOwnerType,
  type EfficientModelPool,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import * as z from 'zod';
import { DurableObject } from 'cloudflare:workers';

type AutoRoutingModeEnv = Pick<Env, 'AUTO_ROUTING_MODE_CONFIG'>;

const MODE_STORAGE_KEY = 'mode';
const POOL_STORAGE_KEY = 'pool';
const CONVERTED_AT_KEY = 'convertedAt';
const FAILED_AT_KEY = 'conversionFailedAt';
const CONVERSION_PENDING_KEY = 'conversionPending';
const POOL_MIGRATED_KEY = 'poolMigratedAt';

const PendingConversionSettingsSchema = z.object({
  mode: AutoRoutingModeSchema.nullable(),
  pool: PersistedEfficientModelPoolSchema,
});

export const LEGACY_POOL_MIGRATION_WRITE_ERROR =
  'This pool is being migrated or already migrated. Retry the edit in custom router settings.';

export type StoredOwnerSettings = AutoRoutingOwnerSettings & {
  invalidMode: boolean;
  invalidPool: boolean;
  convertedAt: string | null;
  failedAt: string | null;
};

export type AutoRoutingOwnerSettings = {
  mode: AutoRoutingMode | null;
  pool: EfficientModelPool | null;
};

const AUTO_ROUTING_SETTINGS_TTL_MS = 30_000;
const AUTO_ROUTING_SETTINGS_CACHE_MAX_ENTRIES = 1_024;
const autoRoutingSettingsCache = new Map<
  string,
  { promise: Promise<AutoRoutingOwnerSettings>; expiresAt: number }
>();

export function clearAutoRoutingSettingsCache(): void {
  autoRoutingSettingsCache.clear();
}

function modeKey(ownerType: AutoRoutingModeOwnerType, ownerId: string): string {
  return `${ownerType}:${ownerId}`;
}

function parseStoredMode(raw: unknown): AutoRoutingMode | null {
  const parsed = AutoRoutingModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseStoredOwnerSettings(stored: Map<string, unknown>): StoredOwnerSettings {
  const rawMode = stored.get(MODE_STORAGE_KEY);
  const rawPool = stored.get(POOL_STORAGE_KEY);
  const convertedAt = stored.get(CONVERTED_AT_KEY);
  const failedAt = stored.get(FAILED_AT_KEY);
  const mode = AutoRoutingModeSchema.safeParse(rawMode);
  const pool = PersistedEfficientModelPoolSchema.safeParse(rawPool);
  const pending = PendingConversionSettingsSchema.safeParse(stored.get(CONVERSION_PENDING_KEY));
  return {
    mode: pending.success ? pending.data.mode : mode.success ? mode.data : null,
    pool: pending.success ? pending.data.pool : pool.success ? pool.data : null,
    invalidMode: !pending.success && rawMode !== undefined && rawMode !== null && !mode.success,
    invalidPool: !pending.success && rawPool !== undefined && rawPool !== null && !pool.success,
    convertedAt: typeof convertedAt === 'string' ? convertedAt : null,
    failedAt: typeof failedAt === 'string' ? failedAt : null,
  };
}

export class AutoRoutingModeConfigDO extends DurableObject<Env> {
  async readStoredSettings(): Promise<StoredOwnerSettings> {
    const stored = await this.ctx.storage.get<unknown>([
      MODE_STORAGE_KEY,
      POOL_STORAGE_KEY,
      CONVERTED_AT_KEY,
      FAILED_AT_KEY,
      CONVERSION_PENDING_KEY,
    ]);
    return parseStoredOwnerSettings(stored);
  }

  async beginConversion(requested?: AutoRoutingOwnerSettings): Promise<StoredOwnerSettings> {
    return this.ctx.storage.transaction(async txn => {
      const stored = await txn.get<unknown>([
        MODE_STORAGE_KEY,
        POOL_STORAGE_KEY,
        CONVERTED_AT_KEY,
        FAILED_AT_KEY,
        CONVERSION_PENDING_KEY,
        POOL_MIGRATED_KEY,
      ]);
      let settings = parseStoredOwnerSettings(stored);
      if (
        requested?.pool &&
        !stored.has(CONVERSION_PENDING_KEY) &&
        !stored.has(POOL_MIGRATED_KEY) &&
        (settings.pool === null ||
          !CustomRouterEntriesSchema.safeParse(
            settings.pool.map(entry => ({ kind: 'gateway', model: entry.model }))
          ).success)
      ) {
        settings = { ...settings, ...requested, invalidMode: false, invalidPool: false };
      }
      if (
        settings.convertedAt === null &&
        settings.pool !== null &&
        CustomRouterEntriesSchema.safeParse(
          settings.pool.map(entry => ({ kind: 'gateway', model: entry.model }))
        ).success
      ) {
        await txn.put(CONVERSION_PENDING_KEY, { mode: settings.mode, pool: settings.pool });
      }
      return settings;
    });
  }

  async markConverted(at: string, migrated = false): Promise<void> {
    await this.ctx.storage.transaction(async txn => {
      await txn.put({
        [CONVERTED_AT_KEY]: at,
        ...(migrated ? { [POOL_MIGRATED_KEY]: at } : {}),
      });
      await txn.delete(CONVERSION_PENDING_KEY);
    });
  }

  private async assertLegacyWritesAllowed(txn: DurableObjectTransaction): Promise<void> {
    const markers = await txn.get([CONVERSION_PENDING_KEY, POOL_MIGRATED_KEY]);
    if (markers.has(CONVERSION_PENDING_KEY) || markers.has(POOL_MIGRATED_KEY)) {
      throw new Error(LEGACY_POOL_MIGRATION_WRITE_ERROR);
    }
  }

  async markFailed(at: string): Promise<void> {
    await this.ctx.storage.put(FAILED_AT_KEY, at);
  }

  async getMode(): Promise<AutoRoutingMode | null> {
    return parseStoredMode(await this.ctx.storage.get(MODE_STORAGE_KEY));
  }

  async setMode(mode: AutoRoutingMode | null): Promise<void> {
    await this.ctx.storage.transaction(async txn => {
      await this.assertLegacyWritesAllowed(txn);
      if (mode === null) await txn.delete(MODE_STORAGE_KEY);
      else await txn.put(MODE_STORAGE_KEY, mode);
    });
  }

  async getPool(): Promise<EfficientModelPool | null> {
    let poolToNormalize: EfficientModelPool | null = null;
    try {
      return await this.ctx.storage.transaction(async txn => {
        const raw = await txn.get(POOL_STORAGE_KEY);
        const parsed = PersistedEfficientModelPoolSchema.safeParse(raw);
        if (!parsed.success) return null;
        if (JSON.stringify(raw) !== JSON.stringify(parsed.data)) {
          poolToNormalize = parsed.data;
          await txn.put(POOL_STORAGE_KEY, parsed.data);
        }
        return parsed.data;
      });
    } catch (error) {
      if (poolToNormalize !== null) return poolToNormalize;
      throw error;
    }
  }

  async setPool(pool: EfficientModelPool | null): Promise<void> {
    await this.ctx.storage.transaction(async txn => {
      await this.assertLegacyWritesAllowed(txn);
      if (pool === null) await txn.delete(POOL_STORAGE_KEY);
      else await txn.put(POOL_STORAGE_KEY, pool);
    });
  }

  async getSettings(): Promise<AutoRoutingOwnerSettings> {
    const [mode, pool] = await Promise.all([this.getMode(), this.getPool()]);
    return { mode, pool };
  }

  async setSettings(settings: AutoRoutingOwnerSettings): Promise<void> {
    const toPut: Record<string, unknown> = {};
    const toDelete: string[] = [];
    if (settings.mode === null) {
      toDelete.push(MODE_STORAGE_KEY);
    } else {
      toPut[MODE_STORAGE_KEY] = settings.mode;
    }
    if (settings.pool === null) {
      toDelete.push(POOL_STORAGE_KEY);
    } else {
      toPut[POOL_STORAGE_KEY] = settings.pool;
    }
    if (Object.keys(toPut).length === 0 && toDelete.length === 0) {
      return;
    }
    await this.ctx.storage.transaction(async txn => {
      await this.assertLegacyWritesAllowed(txn);
      if (Object.keys(toPut).length > 0) {
        await txn.put(toPut);
      }
      if (toDelete.length > 0) {
        await txn.delete(toDelete);
      }
    });
  }
}

function modeStub(env: AutoRoutingModeEnv, ownerType: AutoRoutingModeOwnerType, ownerId: string) {
  const namespace = env.AUTO_ROUTING_MODE_CONFIG;
  return namespace.get(namespace.idFromName(modeKey(ownerType, ownerId)));
}

export async function getConfiguredAutoRoutingMode(
  env: AutoRoutingModeEnv,
  owner: { ownerType: AutoRoutingModeOwnerType; ownerId: string }
): Promise<AutoRoutingMode | null> {
  return modeStub(env, owner.ownerType, owner.ownerId)
    .getMode()
    .catch((error: unknown) => {
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

async function readAutoRoutingSettings(
  env: AutoRoutingModeEnv,
  owner: { ownerType: AutoRoutingModeOwnerType; ownerId: string }
): Promise<AutoRoutingOwnerSettings> {
  return modeStub(env, owner.ownerType, owner.ownerId)
    .getSettings()
    .catch((error: unknown) => {
      console.warn(
        JSON.stringify({
          event: 'auto_routing_config_read_failed',
          key: modeKey(owner.ownerType, owner.ownerId),
          ...formatError(error),
        })
      );
      throw error;
    });
}

export async function getConfiguredAutoRoutingSettings(
  env: AutoRoutingModeEnv,
  owner: { ownerType: AutoRoutingModeOwnerType; ownerId: string }
): Promise<AutoRoutingOwnerSettings> {
  return readAutoRoutingSettings(env, owner).catch(() => ({ mode: null, pool: null }));
}

export function getCachedAutoRoutingSettings(
  env: AutoRoutingModeEnv,
  owner: { ownerType: AutoRoutingModeOwnerType; ownerId: string }
): Promise<AutoRoutingOwnerSettings> {
  const key = modeKey(owner.ownerType, owner.ownerId);
  const now = Date.now();
  const cached = autoRoutingSettingsCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }
  autoRoutingSettingsCache.delete(key);
  if (autoRoutingSettingsCache.size >= AUTO_ROUTING_SETTINGS_CACHE_MAX_ENTRIES) {
    const oldestKey = autoRoutingSettingsCache.keys().next().value;
    if (oldestKey !== undefined) {
      autoRoutingSettingsCache.delete(oldestKey);
    }
  }
  const promise = readAutoRoutingSettings(env, owner).catch(() => {
    if (autoRoutingSettingsCache.get(key) === entry) {
      autoRoutingSettingsCache.delete(key);
    }
    return { mode: null, pool: null };
  });
  const entry = { promise, expiresAt: now + AUTO_ROUTING_SETTINGS_TTL_MS };
  autoRoutingSettingsCache.set(key, entry);
  return promise;
}

export async function getAutoRoutingMode(
  env: AutoRoutingModeEnv,
  owner: { userId: string; organizationId: string | null }
): Promise<AutoRoutingMode> {
  const settings = await getEffectiveAutoRoutingSettings(env, owner);
  return settings.mode;
}

/**
 * Resolve mode and pool independently with organization → personal → platform
 * precedence per field. A configured org mode does not imply an org pool.
 */
export async function getEffectiveAutoRoutingSettings(
  env: AutoRoutingModeEnv,
  owner: { userId: string; organizationId: string | null }
): Promise<{ mode: AutoRoutingMode; pool: EfficientModelPool | null }> {
  const userSettingsPromise = getCachedAutoRoutingSettings(env, {
    ownerType: 'user',
    ownerId: owner.userId,
  });
  const orgSettingsPromise = owner.organizationId
    ? getCachedAutoRoutingSettings(env, {
        ownerType: 'org',
        ownerId: owner.organizationId,
      })
    : Promise.resolve({ mode: null, pool: null } satisfies AutoRoutingOwnerSettings);

  const [orgSettings, userSettings] = await Promise.all([orgSettingsPromise, userSettingsPromise]);

  return {
    mode: orgSettings.mode ?? userSettings.mode ?? DEFAULT_AUTO_ROUTING_MODE,
    pool: orgSettings.pool ?? userSettings.pool ?? null,
  };
}

export async function setAutoRoutingMode(
  env: AutoRoutingModeEnv,
  owner: { ownerType: AutoRoutingModeOwnerType; ownerId: string },
  mode: AutoRoutingMode | null
): Promise<void> {
  await modeStub(env, owner.ownerType, owner.ownerId).setMode(mode);
}

export async function setAutoRoutingSettings(
  env: AutoRoutingModeEnv,
  owner: { ownerType: AutoRoutingModeOwnerType; ownerId: string },
  settings: AutoRoutingOwnerSettings
): Promise<void> {
  await modeStub(env, owner.ownerType, owner.ownerId).setSettings(settings);
}

import {
  AutoRoutingModeSchema,
  CustomRouterEntriesSchema,
  PersistedEfficientModelPoolSchema,
  type AutoRoutingMode,
  type EfficientModelPool,
} from '@kilocode/auto-routing-contracts';
import * as z from 'zod';
import { DurableObject } from 'cloudflare:workers';

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

export type StoredOwnerSettings = {
  mode: AutoRoutingMode | null;
  pool: EfficientModelPool | null;
  invalidMode: boolean;
  invalidPool: boolean;
  convertedAt: string | null;
  failedAt: string | null;
};

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

  async beginConversion(): Promise<StoredOwnerSettings> {
    return this.ctx.storage.transaction(async txn => {
      const stored = await txn.get<unknown>([
        MODE_STORAGE_KEY,
        POOL_STORAGE_KEY,
        CONVERTED_AT_KEY,
        FAILED_AT_KEY,
        CONVERSION_PENDING_KEY,
        POOL_MIGRATED_KEY,
      ]);
      const settings = parseStoredOwnerSettings(stored);
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

  async markFailed(at: string): Promise<void> {
    await this.ctx.storage.put(FAILED_AT_KEY, at);
  }
}

import {
  AutoRoutingModeSchema,
  PersistedEfficientModelPoolSchema,
  type AutoRoutingMode,
  type EfficientModelPool,
} from '@kilocode/auto-routing-contracts';
import { DurableObject } from 'cloudflare:workers';

// Set once the ADR 0005 conversion has handled this owner (converted, or found no live owner), so
// a rerun never recreates a router the owner has since edited or deleted.
const CONVERTED_AT_KEY = 'convertedAt';
// Set when a conversion attempt failed, so a retry does not count that owner toward an outage.
const FAILED_AT_KEY = 'conversionFailedAt';

export type StoredOwnerSettings = {
  mode: AutoRoutingMode | null;
  pool: EfficientModelPool | null;
  // A mode or pool is stored but fails validation, so it cannot be converted as is.
  invalidMode: boolean;
  invalidPool: boolean;
  convertedAt: string | null;
  failedAt: string | null;
};

function isStored(value: unknown): boolean {
  return value !== undefined && value !== null;
}

export class AutoRoutingModeConfigDO extends DurableObject<Env> {
  async readStoredSettings(): Promise<StoredOwnerSettings> {
    const stored = await this.ctx.storage.get(['mode', 'pool', CONVERTED_AT_KEY, FAILED_AT_KEY]);
    const rawMode = stored.get('mode');
    const rawPool = stored.get('pool');
    const convertedAt = stored.get(CONVERTED_AT_KEY);
    const failedAt = stored.get(FAILED_AT_KEY);
    const mode = AutoRoutingModeSchema.safeParse(rawMode);
    const pool = PersistedEfficientModelPoolSchema.safeParse(rawPool);
    return {
      mode: mode.success ? mode.data : null,
      pool: pool.success ? pool.data : null,
      invalidMode: isStored(rawMode) && !mode.success,
      invalidPool: isStored(rawPool) && !pool.success,
      convertedAt: typeof convertedAt === 'string' ? convertedAt : null,
      failedAt: typeof failedAt === 'string' ? failedAt : null,
    };
  }

  async markConverted(at: string): Promise<void> {
    await this.ctx.storage.put(CONVERTED_AT_KEY, at);
  }

  async markFailed(at: string): Promise<void> {
    await this.ctx.storage.put(FAILED_AT_KEY, at);
  }
}

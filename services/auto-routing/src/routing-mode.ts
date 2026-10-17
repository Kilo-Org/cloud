import {
  AutoRoutingModeSchema,
  PersistedEfficientModelPoolSchema,
  type AutoRoutingMode,
  type EfficientModelPool,
} from '@kilocode/auto-routing-contracts';
import { DurableObject } from 'cloudflare:workers';

export type StoredOwnerSettings = {
  mode: AutoRoutingMode | null;
  pool: EfficientModelPool | null;
  // A pool is stored but fails validation, so it cannot be converted as is.
  invalidPool: boolean;
};

export class AutoRoutingModeConfigDO extends DurableObject<Env> {
  async readStoredSettings(): Promise<StoredOwnerSettings> {
    const stored = await this.ctx.storage.get(['mode', 'pool']);
    const mode = AutoRoutingModeSchema.safeParse(stored.get('mode'));
    const rawPool = stored.get('pool');
    const pool = PersistedEfficientModelPoolSchema.safeParse(rawPool);
    return {
      mode: mode.success ? mode.data : null,
      pool: pool.success ? pool.data : null,
      invalidPool: rawPool !== undefined && rawPool !== null && !pool.success,
    };
  }
}

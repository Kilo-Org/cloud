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
};

export class AutoRoutingModeConfigDO extends DurableObject<Env> {
  async readStoredSettings(): Promise<StoredOwnerSettings> {
    const stored = await this.ctx.storage.get(['mode', 'pool']);
    const mode = AutoRoutingModeSchema.safeParse(stored.get('mode'));
    const pool = PersistedEfficientModelPoolSchema.safeParse(stored.get('pool'));
    return {
      mode: mode.success ? mode.data : null,
      pool: pool.success ? pool.data : null,
    };
  }
}

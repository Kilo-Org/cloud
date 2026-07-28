import {
  AutoRoutingModeSchema,
  DEFAULT_AUTO_ROUTING_MODE,
  EfficientModelPoolSchema,
  type AutoRoutingMode,
  type AutoRoutingModeOwnerType,
  type EfficientModelPool,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import { DurableObject } from 'cloudflare:workers';

type AutoRoutingModeEnv = Pick<Env, 'AUTO_ROUTING_MODE_CONFIG'>;

const MODE_STORAGE_KEY = 'mode';
const POOL_STORAGE_KEY = 'pool';

export type AutoRoutingOwnerSettings = {
  mode: AutoRoutingMode | null;
  pool: EfficientModelPool | null;
};

function modeKey(ownerType: AutoRoutingModeOwnerType, ownerId: string): string {
  return `${ownerType}:${ownerId}`;
}

function parseStoredMode(raw: unknown): AutoRoutingMode | null {
  const parsed = AutoRoutingModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseStoredPool(raw: unknown): EfficientModelPool | null {
  const parsed = EfficientModelPoolSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export class AutoRoutingModeConfigDO extends DurableObject<Env> {
  async getMode(): Promise<AutoRoutingMode | null> {
    return parseStoredMode(await this.ctx.storage.get(MODE_STORAGE_KEY));
  }

  async setMode(mode: AutoRoutingMode | null): Promise<void> {
    if (mode === null) {
      await this.ctx.storage.delete(MODE_STORAGE_KEY);
      return;
    }
    await this.ctx.storage.put(MODE_STORAGE_KEY, mode);
  }

  async getPool(): Promise<EfficientModelPool | null> {
    return parseStoredPool(await this.ctx.storage.get(POOL_STORAGE_KEY));
  }

  async setPool(pool: EfficientModelPool | null): Promise<void> {
    if (pool === null) {
      await this.ctx.storage.delete(POOL_STORAGE_KEY);
      return;
    }
    await this.ctx.storage.put(POOL_STORAGE_KEY, pool);
  }

  async getSettings(): Promise<AutoRoutingOwnerSettings> {
    const [mode, pool] = await Promise.all([this.getMode(), this.getPool()]);
    return { mode, pool };
  }

  async setSettings(settings: AutoRoutingOwnerSettings): Promise<void> {
    // Mode and pool commit or fail together via multi-key storage ops.
    // setMode/setPool stay single-key for individual callers.
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
    const ops: Promise<unknown>[] = [];
    if (Object.keys(toPut).length > 0) {
      ops.push(this.ctx.storage.put(toPut));
    }
    if (toDelete.length > 0) {
      ops.push(this.ctx.storage.delete(toDelete));
    }
    if (ops.length > 0) {
      await Promise.all(ops);
    }
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

export async function getConfiguredAutoRoutingSettings(
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
      return { mode: null, pool: null };
    });
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
  const userSettingsPromise = getConfiguredAutoRoutingSettings(env, {
    ownerType: 'user',
    ownerId: owner.userId,
  });
  const orgSettingsPromise = owner.organizationId
    ? getConfiguredAutoRoutingSettings(env, {
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

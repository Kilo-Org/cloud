import {
  AutoRoutingModeSchema,
  DEFAULT_AUTO_ROUTING_MODE,
  type AutoRoutingMode,
  type AutoRoutingModeOwnerType,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import { DurableObject } from 'cloudflare:workers';

type AutoRoutingModeEnv = Pick<Env, 'AUTO_ROUTING_MODE_CONFIG'>;

const MODE_STORAGE_KEY = 'mode';

function modeKey(ownerType: AutoRoutingModeOwnerType, ownerId: string): string {
  return `${ownerType}:${ownerId}`;
}

function parseStoredMode(raw: unknown): AutoRoutingMode | null {
  const parsed = AutoRoutingModeSchema.safeParse(raw);
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
  await modeStub(env, owner.ownerType, owner.ownerId).setMode(mode);
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_ROUTING_MODE_CONFIG_PREFIX,
  clearAutoRoutingModeCache,
  getAutoRoutingMode,
  setAutoRoutingMode,
} from './routing-mode';

type ModeEnvStub = Pick<Env, 'AUTO_ROUTING_CONFIG'>;

function makeEnv(values: Record<string, string | null> = {}) {
  const configGet = vi.fn(async (key: string) => values[key] ?? null);
  const configPut = vi.fn(async (key: string, value: string) => {
    values[key] = value;
  });
  const configDelete = vi.fn(async (key: string) => {
    values[key] = null;
  });
  const env = {
    AUTO_ROUTING_CONFIG: {
      get: configGet,
      put: configPut,
      delete: configDelete,
    },
  } as unknown as ModeEnvStub;

  return { env, configGet, configPut, configDelete };
}

describe('auto routing mode config', () => {
  beforeEach(() => {
    clearAutoRoutingModeCache();
  });

  it('defaults to least cost per accuracy when no owner config exists', async () => {
    const { env } = makeEnv();

    await expect(getAutoRoutingMode(env, { userId: 'user-1', organizationId: null })).resolves.toBe(
      'cost_per_accuracy'
    );
  });

  it('uses organization mode before user mode', async () => {
    const { env, configGet } = makeEnv({
      [`${AUTO_ROUTING_MODE_CONFIG_PREFIX}:user:user-1`]: 'best_accuracy',
      [`${AUTO_ROUTING_MODE_CONFIG_PREFIX}:org:org-1`]: 'cost_per_accuracy',
    });

    await expect(
      getAutoRoutingMode(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toBe('cost_per_accuracy');
    expect(configGet).toHaveBeenNthCalledWith(1, `${AUTO_ROUTING_MODE_CONFIG_PREFIX}:org:org-1`);
  });

  it('falls back to user mode when organization mode is absent', async () => {
    const { env } = makeEnv({
      [`${AUTO_ROUTING_MODE_CONFIG_PREFIX}:user:user-1`]: 'best_accuracy',
    });

    await expect(
      getAutoRoutingMode(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toBe('best_accuracy');
  });

  it('ignores invalid KV values and returns the default mode', async () => {
    const { env } = makeEnv({
      [`${AUTO_ROUTING_MODE_CONFIG_PREFIX}:user:user-1`]: 'fastest',
    });

    await expect(getAutoRoutingMode(env, { userId: 'user-1', organizationId: null })).resolves.toBe(
      'cost_per_accuracy'
    );
  });

  it('writes and clears owner-specific modes', async () => {
    const { env, configPut, configDelete } = makeEnv();

    await setAutoRoutingMode(env, { ownerType: 'org', ownerId: 'org-1' }, 'best_accuracy');
    expect(configPut).toHaveBeenCalledWith(
      `${AUTO_ROUTING_MODE_CONFIG_PREFIX}:org:org-1`,
      'best_accuracy'
    );

    await setAutoRoutingMode(env, { ownerType: 'org', ownerId: 'org-1' }, null);
    expect(configDelete).toHaveBeenCalledWith(`${AUTO_ROUTING_MODE_CONFIG_PREFIX}:org:org-1`);
  });
});

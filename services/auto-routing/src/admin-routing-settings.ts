import {
  AutoRoutingModeOwnerQuerySchema,
  AutoRoutingSettingsResponseSchema,
  BenchmarkProfileQuotaErrorSchema,
  DEFAULT_AUTO_ROUTING_MODE,
  UpdateAutoRoutingSettingsRequestSchema,
  type AutoRoutingMode,
  type AutoRoutingModeOwnerType,
  type AutoRoutingSettingsResponse,
  type BenchmarkProfileEntryStatus,
  type EfficientModelPool,
} from '@kilocode/auto-routing-contracts';
import type { Handler } from 'hono';
import {
  BenchmarkProfileQuotaError,
  fetchBenchmarkProfileStatuses,
  registerBenchmarkProfiles,
} from './benchmark-origin';
import { CustomRouterError, customRouterErrorResponse } from './caller-auth';
import { getSharedOwnerSettings, updateSharedPoolRouter } from './legacy-pool-overlap';
import type { HonoEnv } from './hono-env';
import { migrateOwnerPoolForSettings } from './owner-pool-conversion';
import {
  clearAutoRoutingSettingsCache,
  LEGACY_POOL_MIGRATION_WRITE_ERROR,
  setAutoRoutingSettings,
} from './routing-mode';

function settingsResponse(params: {
  ownerType: AutoRoutingModeOwnerType;
  ownerId: string;
  configuredMode: AutoRoutingMode | null;
  configuredPool: EfficientModelPool | null;
  poolStatuses: BenchmarkProfileEntryStatus[];
}): AutoRoutingSettingsResponse {
  return AutoRoutingSettingsResponseSchema.parse({
    ownerType: params.ownerType,
    ownerId: params.ownerId,
    mode: params.configuredMode ?? DEFAULT_AUTO_ROUTING_MODE,
    configuredMode: params.configuredMode,
    defaultMode: DEFAULT_AUTO_ROUTING_MODE,
    configuredPool: params.configuredPool,
    poolStatuses: params.poolStatuses,
  });
}

export const getRoutingSettingsHandler: Handler<HonoEnv> = async c => {
  const parsed = AutoRoutingModeOwnerQuerySchema.safeParse({
    ownerType: c.req.query('ownerType'),
    ownerId: c.req.query('ownerId'),
  });
  if (!parsed.success) {
    return c.json({ error: 'Invalid routing settings owner' }, 400);
  }

  const configured = await getSharedOwnerSettings(c.env, parsed.data);
  if (configured.router) {
    return c.json(
      settingsResponse({
        ...parsed.data,
        configuredMode: configured.mode,
        configuredPool: configured.pool,
        poolStatuses: [],
      })
    );
  }
  if (configured.pool === null) {
    return c.json(
      settingsResponse({
        ...parsed.data,
        configuredMode: configured.mode,
        configuredPool: null,
        poolStatuses: [],
      })
    );
  }

  try {
    const statuses = await fetchBenchmarkProfileStatuses(c.env, configured.pool);
    return c.json(
      settingsResponse({
        ...parsed.data,
        configuredMode: configured.mode,
        configuredPool: configured.pool,
        poolStatuses: statuses.statuses,
      })
    );
  } catch {
    return c.json({ error: 'Failed to load pool profile statuses' }, 502);
  }
};

export const putRoutingSettingsHandler: Handler<HonoEnv> = async c => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = UpdateAutoRoutingSettingsRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid routing settings' }, 400);
  }

  const { ownerType, ownerId, mode, pool, retryEntries } = parsed.data;
  const owner = { ownerType, ownerId };
  let configured = await getSharedOwnerSettings(c.env, owner).catch(() => null);
  if (!configured) {
    return c.json(
      { error: 'Pool settings are unavailable. Retry this edit.', retryable: true },
      503
    );
  }
  let poolStatuses: BenchmarkProfileEntryStatus[] = [];
  if (pool !== null) {
    if (configured.router?.entries.some(entry => entry.kind === 'client')) {
      return customRouterErrorResponse(
        new CustomRouterError(
          'invalid_request',
          'This pool contains client entries; edit it in custom router settings'
        )
      );
    }
    try {
      const registered = await registerBenchmarkProfiles(c.env, {
        ownerType,
        ownerId,
        entries: pool,
        ...(retryEntries !== undefined ? { retryEntries } : {}),
      });
      poolStatuses = registered.statuses;
    } catch (error) {
      if (error instanceof BenchmarkProfileQuotaError) {
        return c.json(
          BenchmarkProfileQuotaErrorSchema.parse({
            error: error.message,
            retryAt: error.retryAt,
          }),
          429
        );
      }
      return c.json({ error: 'Failed to register benchmark profiles' }, 502);
    }
  }
  if (!configured.router && pool !== null) {
    try {
      const outcome = await migrateOwnerPoolForSettings(c.env, owner, { mode, pool });
      if (outcome !== 'created' && outcome !== 'exists') {
        return c.json(
          {
            error: `Pool migration is incomplete (${outcome ?? 'unavailable'}). Retry this edit after migration is available.`,
            retryable: true,
          },
          503
        );
      }
      configured = await getSharedOwnerSettings(c.env, owner);
      if (!configured.router) throw new Error('Migrated pool is unavailable');
    } catch {
      return c.json(
        { error: 'Pool migration is unavailable. Retry this edit.', retryable: true },
        503
      );
    }
  }

  if (configured.router) {
    try {
      const updated = await updateSharedPoolRouter(c.env, configured.router, {
        mode,
        settings: { mode, pool },
      });
      clearAutoRoutingSettingsCache();
      return c.json(
        settingsResponse({
          ownerType,
          ownerId,
          configuredMode: updated.legacyModeInherited ? null : updated.mode,
          configuredPool: pool,
          poolStatuses,
        })
      );
    } catch (error) {
      if (error instanceof CustomRouterError) return customRouterErrorResponse(error);
      return c.json(
        { error: 'Pool settings are unavailable. Retry this edit.', retryable: true },
        503
      );
    }
  }

  try {
    await setAutoRoutingSettings(c.env, { ownerType, ownerId }, { mode, pool });
  } catch (error) {
    if (error instanceof Error && error.message.includes(LEGACY_POOL_MIGRATION_WRITE_ERROR)) {
      return c.json({ error: LEGACY_POOL_MIGRATION_WRITE_ERROR, retryable: true }, 409);
    }
    return c.json(
      { error: 'Pool settings are unavailable. Retry this edit.', retryable: true },
      503
    );
  }
  clearAutoRoutingSettingsCache();

  return c.json(
    settingsResponse({
      ownerType,
      ownerId,
      configuredMode: mode,
      configuredPool: pool,
      poolStatuses,
    })
  );
};

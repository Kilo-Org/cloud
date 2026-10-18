import {
  AutoRoutingModeOwnerQuerySchema,
  AutoRoutingSettingsResponseSchema,
  BenchmarkProfileQuotaErrorSchema,
  DEFAULT_AUTO_ROUTING_MODE,
  UpdateAutoRoutingSettingsRequestSchema,
  InitializeFrontierFallbackRequestSchema,
  type AutoRoutingMode,
  type AutoRoutingModeOwnerType,
  type AutoRoutingSettingsResponse,
  type BenchmarkProfileEntryStatus,
  type EfficientModelPool,
  type FrontierFallbackEntry,
} from '@kilocode/auto-routing-contracts';
import type { Handler } from 'hono';
import {
  BenchmarkProfileQuotaError,
  fetchBenchmarkProfileStatuses,
  registerBenchmarkProfiles,
} from './benchmark-origin';
import type { HonoEnv } from './hono-env';
import {
  clearAutoRoutingSettingsCache,
  getConfiguredAutoRoutingSettings,
  setAutoRoutingSettings,
  initializeFrontierFallback,
} from './routing-mode';

function settingsResponse(params: {
  ownerType: AutoRoutingModeOwnerType;
  ownerId: string;
  configuredMode: AutoRoutingMode | null;
  configuredPool: EfficientModelPool | null;
  frontierFallback?: FrontierFallbackEntry | null;
  poolStatuses: BenchmarkProfileEntryStatus[];
}): AutoRoutingSettingsResponse {
  return AutoRoutingSettingsResponseSchema.parse({
    ownerType: params.ownerType,
    ownerId: params.ownerId,
    mode: params.configuredMode ?? DEFAULT_AUTO_ROUTING_MODE,
    configuredMode: params.configuredMode,
    defaultMode: DEFAULT_AUTO_ROUTING_MODE,
    configuredPool: params.configuredPool,
    ...(params.frontierFallback !== undefined ? { frontierFallback: params.frontierFallback } : {}),
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

  const configured = await getConfiguredAutoRoutingSettings(c.env, parsed.data);
  if (configured.pool === null) {
    return c.json(
      settingsResponse({
        ...parsed.data,
        configuredMode: configured.mode,
        configuredPool: null,
        ...(configured.frontierFallback !== undefined
          ? { frontierFallback: configured.frontierFallback }
          : {}),
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
        ...(configured.frontierFallback !== undefined
          ? { frontierFallback: configured.frontierFallback }
          : {}),
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

  const { ownerType, ownerId, mode, pool, retryEntries, frontierFallback } = parsed.data;

  let poolStatuses: BenchmarkProfileEntryStatus[] = [];
  if (pool !== null) {
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

  // Persist only after successful admission (or when clearing the pool).
  await setAutoRoutingSettings(
    c.env,
    { ownerType, ownerId },
    {
      mode,
      pool,
      ...(frontierFallback !== undefined ? { frontierFallback } : {}),
    }
  );
  clearAutoRoutingSettingsCache();
  const configured = await getConfiguredAutoRoutingSettings(c.env, { ownerType, ownerId });

  return c.json(
    settingsResponse({
      ownerType,
      ownerId,
      configuredMode: mode,
      configuredPool: pool,
      poolStatuses,
      ...(configured.frontierFallback !== undefined
        ? { frontierFallback: configured.frontierFallback }
        : {}),
    })
  );
};

export const getFrontierFallbackHandler: Handler<HonoEnv> = async c => {
  const parsed = AutoRoutingModeOwnerQuerySchema.safeParse({
    ownerType: c.req.query('ownerType'),
    ownerId: c.req.query('ownerId'),
  });
  if (!parsed.success) {
    return c.json({ error: 'Invalid routing settings owner' }, 400);
  }
  const configured = await getConfiguredAutoRoutingSettings(c.env, parsed.data);
  return c.json(
    settingsResponse({
      ...parsed.data,
      configuredMode: configured.mode,
      configuredPool: configured.pool,
      frontierFallback: configured.frontierFallback,
      poolStatuses: [],
    })
  );
};

export const initializeFrontierFallbackHandler: Handler<HonoEnv> = async c => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = InitializeFrontierFallbackRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid Frontier fallback' }, 400);
  }
  const { ownerType, ownerId, frontierFallback } = parsed.data;
  const configured = await initializeFrontierFallback(
    c.env,
    { ownerType, ownerId },
    frontierFallback
  );
  return c.json(
    settingsResponse({
      ownerType,
      ownerId,
      configuredMode: configured.mode,
      configuredPool: configured.pool,
      frontierFallback: configured.frontierFallback,
      poolStatuses: [],
    })
  );
};

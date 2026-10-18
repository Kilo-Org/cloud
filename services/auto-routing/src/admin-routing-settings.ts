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
import type { HonoEnv } from './hono-env';
import {
  clearAutoRoutingSettingsCache,
  getSubscribedAutoRoutingSettings,
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

  try {
    const { settings, statuses } = await getSubscribedAutoRoutingSettings(c.env, parsed.data);
    return c.json(
      settingsResponse({
        ...parsed.data,
        configuredMode: settings.mode,
        configuredPool: settings.pool,
        poolStatuses: statuses,
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

  const { ownerType, ownerId, mode, pool } = parsed.data;
  let poolStatuses: BenchmarkProfileEntryStatus[];
  try {
    const result = await setAutoRoutingSettings(c.env, parsed.data);
    if ('quota' in result) {
      return c.json(BenchmarkProfileQuotaErrorSchema.parse(result.quota), 429);
    }
    poolStatuses = result.statuses;
  } catch {
    return c.json({ error: 'Failed to save routing settings' }, 502);
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

import {
  AutoRoutingModeOwnerQuerySchema,
  DEFAULT_AUTO_ROUTING_MODE,
  UpdateAutoRoutingModeRequestSchema,
  type AutoRoutingMode,
  type AutoRoutingModeOwnerType,
  type AutoRoutingModeResponse,
} from '@kilocode/auto-routing-contracts';
import type { Handler } from 'hono';
import {
  clearAutoRoutingSettingsCache,
  LEGACY_POOL_MIGRATION_WRITE_ERROR,
  setAutoRoutingMode,
} from './routing-mode';
import type { HonoEnv } from './hono-env';
import { getSharedOwnerSettings, updateSharedPoolRouter } from './legacy-pool-overlap';

function responseBody(params: {
  ownerType: AutoRoutingModeOwnerType;
  ownerId: string;
  configuredMode: AutoRoutingMode | null;
}): AutoRoutingModeResponse {
  return {
    ownerType: params.ownerType,
    ownerId: params.ownerId,
    mode: params.configuredMode ?? DEFAULT_AUTO_ROUTING_MODE,
    configuredMode: params.configuredMode,
    defaultMode: DEFAULT_AUTO_ROUTING_MODE,
  };
}

export const getRoutingModeHandler: Handler<HonoEnv> = async c => {
  const parsed = AutoRoutingModeOwnerQuerySchema.safeParse({
    ownerType: c.req.query('ownerType'),
    ownerId: c.req.query('ownerId'),
  });
  if (!parsed.success) {
    return c.json({ error: 'Invalid routing mode owner' }, 400);
  }

  const { mode: configuredMode } = await getSharedOwnerSettings(c.env, parsed.data);
  return c.json(responseBody({ ...parsed.data, configuredMode }));
};

export const putRoutingModeHandler: Handler<HonoEnv> = async c => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = UpdateAutoRoutingModeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid routing mode' }, 400);
  }

  const configured = await getSharedOwnerSettings(c.env, parsed.data);
  if (configured.router) {
    const updated = await updateSharedPoolRouter(c.env, configured.router, {
      mode: parsed.data.mode,
    });
    return c.json(
      responseBody({
        ...parsed.data,
        configuredMode: updated.legacyModeInherited ? null : updated.mode,
      })
    );
  }
  try {
    await setAutoRoutingMode(c.env, parsed.data, parsed.data.mode);
  } catch (error) {
    if (error instanceof Error && error.message.includes(LEGACY_POOL_MIGRATION_WRITE_ERROR)) {
      return c.json({ error: LEGACY_POOL_MIGRATION_WRITE_ERROR }, 409);
    }
    throw error;
  }
  clearAutoRoutingSettingsCache();
  return c.json(responseBody({ ...parsed.data, configuredMode: parsed.data.mode }));
};

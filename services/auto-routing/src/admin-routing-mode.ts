import {
  AutoRoutingModeOwnerQuerySchema,
  DEFAULT_AUTO_ROUTING_MODE,
  UpdateAutoRoutingModeRequestSchema,
  type AutoRoutingMode,
  type OwnerType,
  type AutoRoutingModeResponse,
} from '@kilocode/auto-routing-contracts';
import type { Handler } from 'hono';
import { readConfiguredAutoRoutingMode, setAutoRoutingMode } from './routing-mode';
import type { HonoEnv } from './hono-env';

function responseBody(params: {
  ownerType: OwnerType;
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

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const configuredMode = await readConfiguredAutoRoutingMode(c.env, parsed.data);
      return c.json(responseBody({ ...parsed.data, configuredMode }));
    } catch {
      if (attempt === 1) {
        return c.json({ error: 'Could not load the saved platform mode. Please retry.' }, 503);
      }
    }
  }
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

  await setAutoRoutingMode(c.env, parsed.data, parsed.data.mode);
  return c.json(responseBody({ ...parsed.data, configuredMode: parsed.data.mode }));
};

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { timingSafeEqual } from '@kilocode/encryption';
import type { AppEnv } from '../types';
import { userIdFromSandboxId } from '../auth/sandbox-id';
import { deriveGatewayToken } from '../auth/gateway-token';

const CheckinSchema = z.object({
  sandboxId: z.string().min(1),
  machineId: z.string().optional(),
  controllerVersion: z.string().min(1),
  controllerCommit: z.string().min(1),
  openclawVersion: z.string().nullable(),
  openclawCommit: z.string().nullable(),
  supervisorState: z.string().min(1),
  totalRestarts: z.number().min(0),
  restartsSinceLastCheckin: z.number().min(0),
  uptimeSeconds: z.number().min(0),
  loadAvg5m: z.number().min(0),
  bandwidthBytesIn: z.number().min(0),
  bandwidthBytesOut: z.number().min(0),
  lastExitReason: z.string().optional(),
});

const controller = new Hono<AppEnv>();

controller.post('/checkin', async (c: Context<AppEnv>) => {
  const authHeader = c.req.header('authorization');
  const apiKey = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.substring(7)
    : undefined;

  const gatewayToken = c.req.header('x-kiloclaw-gateway-token');
  if (!apiKey || !gatewayToken) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const rawBody: unknown = await c.req.json().catch((): unknown => null);
  const parsed = CheckinSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body' }, 400);
  }

  const data = parsed.data;

  if (!c.env.GATEWAY_TOKEN_SECRET) {
    return c.json({ error: 'Configuration error' }, 503);
  }

  const expectedGatewayToken = await deriveGatewayToken(data.sandboxId, c.env.GATEWAY_TOKEN_SECRET);
  if (!timingSafeEqual(gatewayToken, expectedGatewayToken)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  let userId: string;
  try {
    userId = userIdFromSandboxId(data.sandboxId);
  } catch {
    return c.json({ error: 'Invalid sandboxId' }, 400);
  }

  const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(userId));
  const config = await stub.getConfig().catch(() => null);
  if (!config?.kilocodeApiKey || !timingSafeEqual(apiKey, config.kilocodeApiKey)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  try {
    const flyRegion = c.req.header('fly-region') ?? '';
    c.env.KILOCLAW_CONTROLLER_AE.writeDataPoint({
      blobs: [
        data.sandboxId,
        data.controllerVersion,
        data.controllerCommit,
        data.openclawVersion ?? '',
        data.openclawCommit ?? '',
        data.supervisorState,
        flyRegion,
        data.machineId ?? '',
        data.lastExitReason ?? '',
      ],
      doubles: [
        data.restartsSinceLastCheckin,
        data.totalRestarts,
        data.uptimeSeconds,
        data.loadAvg5m,
        data.bandwidthBytesIn,
        data.bandwidthBytesOut,
      ],
      indexes: [data.sandboxId],
    });
  } catch {
    // Best-effort: never fail checkin on AE write errors
  }

  return c.body(null, 204);
});

export { controller };

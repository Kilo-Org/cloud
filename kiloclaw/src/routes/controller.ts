import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { timingSafeEqual } from '@kilocode/encryption';
import type { AppEnv } from '../types';
import { userIdFromSandboxId } from '../auth/sandbox-id';
import { deriveGatewayToken } from '../auth/gateway-token';
import { waitUntil } from 'cloudflare:workers';
import { getWorkerDb, findEmailByUserId } from '../db';
import { capturePostHogEvent } from '../lib/posthog';

const ProductTelemetrySchema = z.object({
  openclawVersion: z.string().nullable(),
  defaultModel: z.string().nullable(),
  channelCount: z.number().int().min(0),
  enabledChannels: z.array(z.string()),
  toolsProfile: z.string().nullable(),
  execSecurity: z.string().nullable(),
  browserEnabled: z.boolean(),
});

const INSTANCE_READY_LOAD_THRESHOLD = 0.1;

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
  productTelemetry: ProductTelemetrySchema.optional(),
});

/**
 * Derive the Next.js app origin for internal API calls.
 */
function nextApiOrigin(kilocodeApiBaseUrl: string | undefined): string {
  if (!kilocodeApiBaseUrl) {
    throw new Error('KILOCODE_API_BASE_URL not defined');
  }
  return new URL(kilocodeApiBaseUrl).origin;
}

/**
 * Fire-and-forget HTTP POST to the Next.js internal API to trigger
 * the "instance ready" transactional email.
 */
async function notifyInstanceReady(
  nextApiUrl: string,
  internalSecret: string,
  userId: string,
  sandboxId: string
): Promise<void> {
  const res = await fetch(`${nextApiUrl}/api/internal/kiloclaw/instance-ready`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': internalSecret,
    },
    body: JSON.stringify({ userId, sandboxId }),
  });
  if (!res.ok) {
    console.error('[controller] instance-ready notification failed:', res.status, await res.text());
  }
}

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

  // Forward product telemetry to PostHog (~every 24h). Skip in development.
  // Runs in background via waitUntil so it never delays the checkin response.
  if (data.productTelemetry && c.env.NEXT_PUBLIC_POSTHOG_KEY && c.env.WORKER_ENV === 'production') {
    const posthogKey = c.env.NEXT_PUBLIC_POSTHOG_KEY;
    const connectionString = c.env.HYPERDRIVE?.connectionString;
    const telemetryPayload = data.productTelemetry;
    const telemetryMeta = {
      sandboxId: data.sandboxId,
      machineId: data.machineId ?? '',
      flyRegion: c.req.header('fly-region') ?? '',
      userId,
    };

    const telemetryPromise = (async () => {
      try {
        let distinctId = userId;
        if (connectionString) {
          const email = await findEmailByUserId(getWorkerDb(connectionString), userId);
          if (email) distinctId = email;
        }

        await capturePostHogEvent({
          apiKey: posthogKey,
          distinctId,
          event: 'kc_instance_product_telemetry',
          properties: { ...telemetryPayload, ...telemetryMeta },
        });
      } catch (err) {
        console.warn('[controller] PostHog capture failed (non-fatal):', err);
      }
    })();

    waitUntil(telemetryPromise);
  }

  // Instance readiness detection: when load drops below threshold, send a
  // one-time "instance ready" email to the user via the Next.js internal API.
  if (data.loadAvg5m <= INSTANCE_READY_LOAD_THRESHOLD) {
    try {
      const { shouldNotify } = await stub.tryMarkInstanceReady();

      if (shouldNotify && c.env.INTERNAL_API_SECRET) {
        const apiOrigin = nextApiOrigin(c.env.KILOCODE_API_BASE_URL);
        waitUntil(
          notifyInstanceReady(apiOrigin, c.env.INTERNAL_API_SECRET, userId, data.sandboxId).catch(
            err => {
              console.error('[controller] instance-ready notification error:', err);
            }
          )
        );
      }
    } catch {
      // Best-effort: never fail checkin on readiness notification errors
    }
  }

  return c.body(null, 204);
});

export { controller };

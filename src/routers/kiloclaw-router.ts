import 'server-only';

import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { KiloClawInternalClient, KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { KiloClawUserClient } from '@/lib/kiloclaw/kiloclaw-user-client';
import { encryptKiloClawSecret } from '@/lib/kiloclaw/encryption';
import { KILOCLAW_API_URL } from '@/lib/config.server';
import { sentryLogger } from '@/lib/utils.server';
import type { KiloClawDashboardStatus, KiloCodeConfigResponse } from '@/lib/kiloclaw/types';
import {
  ensureActiveInstance,
  markActiveInstanceDestroyed,
  restoreDestroyedInstance,
} from '@/lib/kiloclaw/instance-registry';

const updateConfigSchema = z.object({
  envVars: z.record(z.string(), z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  channels: z
    .object({
      telegramBotToken: z.string().optional(),
      discordBotToken: z.string().optional(),
      slackBotToken: z.string().optional(),
      slackAppToken: z.string().optional(),
    })
    .optional(),
  kilocodeDefaultModel: z
    .string()
    .regex(
      /^kilocode\/[^/]+\/.+$/,
      'kilocodeDefaultModel must start with kilocode/ and include a provider'
    )
    .nullable()
    .optional(),
});

const updateKiloCodeConfigSchema = z.object({
  kilocodeDefaultModel: z
    .string()
    .regex(
      /^kilocode\/[^/]+\/.+$/,
      'kilocodeDefaultModel must start with kilocode/ and include a provider'
    )
    .nullable()
    .optional(),
});

const patchChannelsSchema = z.object({
  telegramBotToken: z.string().nullable().optional(),
  discordBotToken: z.string().nullable().optional(),
  slackBotToken: z.string().nullable().optional(),
  slackAppToken: z.string().nullable().optional(),
});

/**
 * Build the worker provision payload from plaintext channel tokens.
 * The worker expects the flat encrypted envelope shape for channels.
 */
function buildWorkerChannels(channels: z.infer<typeof updateConfigSchema>['channels']) {
  if (!channels) return undefined;
  return {
    telegramBotToken: channels.telegramBotToken
      ? encryptKiloClawSecret(channels.telegramBotToken)
      : undefined,
    discordBotToken: channels.discordBotToken
      ? encryptKiloClawSecret(channels.discordBotToken)
      : undefined,
    slackBotToken: channels.slackBotToken
      ? encryptKiloClawSecret(channels.slackBotToken)
      : undefined,
    slackAppToken: channels.slackAppToken
      ? encryptKiloClawSecret(channels.slackAppToken)
      : undefined,
  };
}

/**
 * Encrypt channel tokens for a PATCH (supports null for removal).
 */
function buildWorkerChannelsPatch(channels: z.infer<typeof patchChannelsSchema>) {
  const result: Record<string, ReturnType<typeof encryptKiloClawSecret> | null | undefined> = {};

  for (const [key, value] of Object.entries(channels)) {
    if (value === undefined) continue;
    result[key] = value === null ? null : encryptKiloClawSecret(value);
  }

  return result;
}

type KiloCodeConfigPublicResponse = Pick<
  KiloCodeConfigResponse,
  'kilocodeApiKeyExpiresAt' | 'kilocodeDefaultModel'
>;

function sanitizeKiloCodeConfigResponse(
  response: KiloCodeConfigResponse
): KiloCodeConfigPublicResponse {
  return {
    kilocodeApiKeyExpiresAt: response.kilocodeApiKeyExpiresAt,
    kilocodeDefaultModel: response.kilocodeDefaultModel,
  };
}

async function provisionInstance(
  user: Parameters<typeof generateApiToken>[0],
  input: z.infer<typeof updateConfigSchema>
) {
  await ensureActiveInstance(user.id);

  const encryptedSecrets = input.secrets
    ? Object.fromEntries(
        Object.entries(input.secrets).map(([k, v]) => [k, encryptKiloClawSecret(v)])
      )
    : undefined;

  const expiresInSeconds = TOKEN_EXPIRY.thirtyDays;
  const kilocodeApiKey = generateApiToken(user, undefined, {
    expiresIn: expiresInSeconds,
  });
  const kilocodeApiKeyExpiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  const client = new KiloClawInternalClient();
  return client.provision(user.id, {
    envVars: input.envVars,
    encryptedSecrets,
    channels: buildWorkerChannels(input.channels),
    kilocodeApiKey,
    kilocodeApiKeyExpiresAt,
    kilocodeDefaultModel: input.kilocodeDefaultModel ?? undefined,
  });
}

async function patchConfig(
  user: Parameters<typeof generateApiToken>[0],
  input: z.infer<typeof updateKiloCodeConfigSchema>
): Promise<KiloCodeConfigPublicResponse> {
  const client = new KiloClawInternalClient();
  const expiresInSeconds = TOKEN_EXPIRY.thirtyDays;
  const kilocodeApiKey = generateApiToken(user, undefined, {
    expiresIn: expiresInSeconds,
  });
  const kilocodeApiKeyExpiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  const response = await client.patchKiloCodeConfig(user.id, {
    ...input,
    kilocodeApiKey,
    kilocodeApiKeyExpiresAt,
  });

  return sanitizeKiloCodeConfigResponse(response);
}

const KILOCLAW_STATUS_PAGE_RESOURCE_ID = '8737418';
const STATUS_PAGE_TIMEOUT_MS = 5_000;

const logStatusPageWarning = sentryLogger('kiloclaw-status-page', 'warning');

async function fetchKiloClawServiceDegraded(): Promise<boolean> {
  try {
    const response = await fetch('https://status.kilo.ai/index.json', {
      signal: AbortSignal.timeout(STATUS_PAGE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const data = await response.json();
    const included: Array<{ id: string; type: string; attributes?: { status?: string } }> =
      data.included ?? [];
    const resource = included.find(
      entry =>
        entry.type === 'status_page_resource' && entry.id === KILOCLAW_STATUS_PAGE_RESOURCE_ID
    );
    if (!resource) {
      logStatusPageWarning(
        `Status page resource ${KILOCLAW_STATUS_PAGE_RESOURCE_ID} not found in status page response`
      );
      return false;
    }
    return resource.attributes?.status != null && resource.attributes.status !== 'operational';
  } catch {
    return false;
  }
}

export const kiloclawRouter = createTRPCRouter({
  serviceDegraded: baseProcedure.query(async () => {
    return fetchKiloClawServiceDegraded();
  }),

  // Status + gateway token (two internal client calls, merged for the dashboard)
  getStatus: baseProcedure.query(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    const status = await client.getStatus(ctx.user.id);

    let gatewayToken: string | null = null;
    if (status.sandboxId) {
      try {
        const tokenResp = await client.getGatewayToken(ctx.user.id);
        gatewayToken = tokenResp.gatewayToken;
      } catch {
        // non-fatal -- dashboard still works without token
      }
    }

    const workerUrl = KILOCLAW_API_URL || 'https://claw.kilo.ai';

    return { ...status, gatewayToken, workerUrl } satisfies KiloClawDashboardStatus;
  }),

  // Instance lifecycle
  start: baseProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.start(ctx.user.id);
  }),

  stop: baseProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.stop(ctx.user.id);
  }),

  // Instance lifecycle
  destroy: baseProcedure.mutation(async ({ ctx }) => {
    const destroyedRow = await markActiveInstanceDestroyed(ctx.user.id);
    const client = new KiloClawInternalClient();
    try {
      return await client.destroy(ctx.user.id);
    } catch (error) {
      if (destroyedRow) {
        await restoreDestroyedInstance(destroyedRow.id);
      }
      throw error;
    }
  }),

  // Explicit lifecycle APIs
  provision: baseProcedure.input(updateConfigSchema).mutation(async ({ ctx, input }) => {
    return provisionInstance(ctx.user, input);
  }),

  patchConfig: baseProcedure.input(updateKiloCodeConfigSchema).mutation(async ({ ctx, input }) => {
    return patchConfig(ctx.user, input);
  }),

  // Backward-compatible aliases.
  updateConfig: baseProcedure.input(updateConfigSchema).mutation(async ({ ctx, input }) => {
    return provisionInstance(ctx.user, input);
  }),

  updateKiloCodeConfig: baseProcedure
    .input(updateKiloCodeConfigSchema)
    .mutation(async ({ ctx, input }) => {
      return patchConfig(ctx.user, input);
    }),

  patchChannels: baseProcedure.input(patchChannelsSchema).mutation(async ({ ctx, input }) => {
    const client = new KiloClawInternalClient();
    return client.patchChannels(ctx.user.id, {
      channels: buildWorkerChannelsPatch(input),
    });
  }),

  // User-facing (user client -- forwards user's short-lived JWT)
  getConfig: baseProcedure.query(async ({ ctx }) => {
    const client = new KiloClawUserClient(
      generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes })
    );
    return client.getConfig();
  }),

  restartGateway: baseProcedure
    .input(
      z
        .object({
          imageTag: z
            .string()
            .max(128, 'Image tag too long')
            .regex(
              /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
              'Image tag must be alphanumeric with dots, hyphens, or underscores'
            )
            .optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      const client = new KiloClawUserClient(
        generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes })
      );
      return client.restartGateway(input?.imageTag ? { imageTag: input.imageTag } : undefined);
    }),

  listPairingRequests: baseProcedure
    .input(z.object({ refresh: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const client = new KiloClawInternalClient();
      return client.listPairingRequests(ctx.user.id, input?.refresh);
    }),

  approvePairingRequest: baseProcedure
    .input(z.object({ channel: z.string().min(1), code: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const client = new KiloClawInternalClient();
      return client.approvePairingRequest(ctx.user.id, input.channel, input.code);
    }),

  listDevicePairingRequests: baseProcedure
    .input(z.object({ refresh: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const client = new KiloClawInternalClient();
      return client.listDevicePairingRequests(ctx.user.id, input?.refresh);
    }),

  approveDevicePairingRequest: baseProcedure
    .input(z.object({ requestId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const client = new KiloClawInternalClient();
      return client.approveDevicePairingRequest(ctx.user.id, input.requestId);
    }),

  gatewayStatus: baseProcedure.query(async ({ ctx }) => {
    try {
      const client = new KiloClawInternalClient();
      return await client.getGatewayStatus(ctx.user.id);
    } catch (err) {
      console.error('Failed to fetch gateway status for user:', ctx.user.id, err);
      if (err instanceof KiloClawApiError && (err.statusCode === 404 || err.statusCode === 409)) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Gateway control unavailable',
        });
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch gateway status',
      });
    }
  }),

  controllerVersion: baseProcedure.query(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.getControllerVersion(ctx.user.id);
  }),

  restartOpenClaw: baseProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.restartGatewayProcess(ctx.user.id);
  }),

  runDoctor: baseProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.runDoctor(ctx.user.id);
  }),

  restoreConfig: baseProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.restoreConfig(ctx.user.id);
  }),
});

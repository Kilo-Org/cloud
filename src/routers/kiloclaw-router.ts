import 'server-only';

import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { KiloClawUserClient } from '@/lib/kiloclaw/kiloclaw-user-client';
import { encryptKiloClawSecret } from '@/lib/kiloclaw/encryption';
import { KILOCLAW_API_URL } from '@/lib/config.server';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import {
  ensureActiveInstance,
  markActiveInstanceDestroyed,
  restoreDestroyedInstance,
} from '@/lib/kiloclaw/instance-registry';

/**
 * Procedure middleware: restrict to @kilocode.ai users.
 */
const kiloclawProcedure = baseProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user.google_user_email?.endsWith('@kilocode.ai')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'KiloClaw access restricted' });
  }
  return next();
});

const modelEntrySchema = z.object({ id: z.string(), name: z.string() });

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
  kilocodeModels: z.array(modelEntrySchema).nullable().optional(),
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
  kilocodeModels: z.array(modelEntrySchema).nullable().optional(),
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
    kilocodeModels: input.kilocodeModels ?? undefined,
  });
}

async function patchConfig(
  user: Parameters<typeof generateApiToken>[0],
  input: z.infer<typeof updateKiloCodeConfigSchema>
) {
  const client = new KiloClawInternalClient();
  const expiresInSeconds = TOKEN_EXPIRY.thirtyDays;
  const kilocodeApiKey = generateApiToken(user, undefined, {
    expiresIn: expiresInSeconds,
  });
  const kilocodeApiKeyExpiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  return client.patchKiloCodeConfig(user.id, {
    ...input,
    kilocodeApiKey,
    kilocodeApiKeyExpiresAt,
  });
}

export const kiloclawRouter = createTRPCRouter({
  // Status + gateway token (two internal client calls, merged for the dashboard)
  getStatus: kiloclawProcedure.query(async ({ ctx }) => {
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
  start: kiloclawProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.start(ctx.user.id);
  }),

  stop: kiloclawProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.stop(ctx.user.id);
  }),

  // Instance lifecycle
  destroy: kiloclawProcedure
    .input(z.object({ deleteData: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const destroyedRow = await markActiveInstanceDestroyed(ctx.user.id);
      const client = new KiloClawInternalClient();
      try {
        return await client.destroy(ctx.user.id, input.deleteData);
      } catch (error) {
        if (destroyedRow) {
          await restoreDestroyedInstance(destroyedRow.id);
        }
        throw error;
      }
    }),

  // Explicit lifecycle APIs
  provision: kiloclawProcedure.input(updateConfigSchema).mutation(async ({ ctx, input }) => {
    return provisionInstance(ctx.user, input);
  }),

  patchConfig: kiloclawProcedure
    .input(updateKiloCodeConfigSchema)
    .mutation(async ({ ctx, input }) => {
      return patchConfig(ctx.user, input);
    }),

  // Backward-compatible aliases.
  updateConfig: kiloclawProcedure.input(updateConfigSchema).mutation(async ({ ctx, input }) => {
    return provisionInstance(ctx.user, input);
  }),

  updateKiloCodeConfig: kiloclawProcedure
    .input(updateKiloCodeConfigSchema)
    .mutation(async ({ ctx, input }) => {
      return patchConfig(ctx.user, input);
    }),

  // User-facing (user client -- forwards user's short-lived JWT)
  getConfig: kiloclawProcedure.query(async ({ ctx }) => {
    const client = new KiloClawUserClient(
      generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes })
    );
    return client.getConfig();
  }),

  getStorageInfo: kiloclawProcedure.query(async ({ ctx }) => {
    const client = new KiloClawUserClient(
      generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes })
    );
    return client.getStorageInfo();
  }),

  restartGateway: kiloclawProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawUserClient(
      generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes })
    );
    return client.restartGateway();
  }),

  syncStorage: kiloclawProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawUserClient(
      generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes })
    );
    return client.syncStorage();
  }),
});

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

/**
 * Procedure middleware: restrict to @kilocode.ai users.
 */
const kiloclawProcedure = baseProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user.google_user_email?.endsWith('@kilocode.ai')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'KiloClaw access restricted' });
  }
  return next();
});

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
});

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

  // Instance lifecycle (internal client)
  start: kiloclawProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.start(ctx.user.id);
  }),

  stop: kiloclawProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.stop(ctx.user.id);
  }),

  destroy: kiloclawProcedure
    .input(z.object({ deleteData: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const client = new KiloClawInternalClient();
      return client.destroy(ctx.user.id, input.deleteData);
    }),

  // Configuration (internal client -- encrypts secrets server-side)
  updateConfig: kiloclawProcedure.input(updateConfigSchema).mutation(async ({ ctx, input }) => {
    const encryptedSecrets = input.secrets
      ? Object.fromEntries(
          Object.entries(input.secrets).map(([k, v]) => [k, encryptKiloClawSecret(v)])
        )
      : undefined;

    const channels = input.channels
      ? {
          telegramBotToken: input.channels.telegramBotToken
            ? encryptKiloClawSecret(input.channels.telegramBotToken)
            : undefined,
          discordBotToken: input.channels.discordBotToken
            ? encryptKiloClawSecret(input.channels.discordBotToken)
            : undefined,
          slackBotToken: input.channels.slackBotToken
            ? encryptKiloClawSecret(input.channels.slackBotToken)
            : undefined,
          slackAppToken: input.channels.slackAppToken
            ? encryptKiloClawSecret(input.channels.slackAppToken)
            : undefined,
        }
      : undefined;

    const client = new KiloClawInternalClient();
    return client.provision(ctx.user.id, {
      envVars: input.envVars,
      encryptedSecrets,
      channels,
    });
  }),

  // User-facing (user client -- forwards user's JWT)
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

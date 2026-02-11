import 'server-only';

import * as z from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { db } from '@/lib/drizzle';
import { kiloclaw_instances } from '@/db/schema';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { KiloClawUserClient } from '@/lib/kiloclaw/kiloclaw-user-client';
import { encryptKiloClawSecret } from '@/lib/kiloclaw/encryption';
import { sandboxIdFromUserId } from '@/lib/kiloclaw/sandbox-id';
import { KILOCLAW_API_URL } from '@/lib/config.server';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import type { KiloClawInstanceVar } from '@/lib/kiloclaw/db-types';

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

/**
 * Build the vars JSONB array from plaintext env vars and plaintext secrets.
 * Secrets are encrypted server-side before storage.
 */
function buildVarsJsonb(
  envVars: Record<string, string> | undefined,
  secrets: Record<string, string> | undefined
): KiloClawInstanceVar[] {
  const vars: KiloClawInstanceVar[] = [];
  if (envVars) {
    for (const [key, value] of Object.entries(envVars)) {
      vars.push({ key, value, is_secret: false });
    }
  }
  if (secrets) {
    for (const [key, value] of Object.entries(secrets)) {
      vars.push({ key, value: JSON.stringify(encryptKiloClawSecret(value)), is_secret: true });
    }
  }
  return vars;
}

/**
 * Build the channels JSONB from plaintext channel tokens.
 * Tokens are encrypted server-side before storage.
 */
function buildChannelsJsonb(channels: z.infer<typeof updateConfigSchema>['channels']) {
  if (!channels) return undefined;
  return {
    telegram: channels.telegramBotToken
      ? { botToken: encryptKiloClawSecret(channels.telegramBotToken) }
      : undefined,
    discord: channels.discordBotToken
      ? { botToken: encryptKiloClawSecret(channels.discordBotToken) }
      : undefined,
    slack:
      channels.slackBotToken || channels.slackAppToken
        ? {
            botToken: channels.slackBotToken
              ? encryptKiloClawSecret(channels.slackBotToken)
              : undefined,
            appToken: channels.slackAppToken
              ? encryptKiloClawSecret(channels.slackAppToken)
              : undefined,
          }
        : undefined,
  };
}

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

  // Destroy: write soft-delete to Postgres first, then tell worker to teardown
  destroy: kiloclawProcedure
    .input(z.object({ deleteData: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(kiloclaw_instances)
        .set({ destroyed_at: new Date().toISOString() })
        .where(
          and(eq(kiloclaw_instances.user_id, ctx.user.id), isNull(kiloclaw_instances.destroyed_at))
        );

      const client = new KiloClawInternalClient();
      return client.destroy(ctx.user.id, input.deleteData);
    }),

  // Configuration: write to Postgres first, then call worker to provision DO
  updateConfig: kiloclawProcedure.input(updateConfigSchema).mutation(async ({ ctx, input }) => {
    const userId = ctx.user.id;
    const sandboxId = sandboxIdFromUserId(userId);

    const vars = buildVarsJsonb(input.envVars, input.secrets);
    const channelsJsonb = buildChannelsJsonb(input.channels);

    // Upsert Postgres: insert if no active row, otherwise update
    const existing = await db
      .select({ id: kiloclaw_instances.id })
      .from(kiloclaw_instances)
      .where(and(eq(kiloclaw_instances.user_id, userId), isNull(kiloclaw_instances.destroyed_at)))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(kiloclaw_instances)
        .set({
          channels: channelsJsonb ?? null,
          vars: vars.length > 0 ? vars : null,
        })
        .where(eq(kiloclaw_instances.id, existing[0].id));
    } else {
      await db.insert(kiloclaw_instances).values({
        user_id: userId,
        sandbox_id: sandboxId,
        channels: channelsJsonb ?? null,
        vars: vars.length > 0 ? vars : null,
      });
    }

    // Then call the worker to provision the DO
    const encryptedSecrets = input.secrets
      ? Object.fromEntries(
          Object.entries(input.secrets).map(([k, v]) => [k, encryptKiloClawSecret(v)])
        )
      : undefined;

    const client = new KiloClawInternalClient();
    return client.provision(userId, {
      envVars: input.envVars,
      encryptedSecrets,
      channels: buildWorkerChannels(input.channels),
    });
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

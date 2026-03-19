import 'server-only';

import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { baseProcedure, createTRPCRouter, UpstreamApiError } from '@/lib/trpc/init';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { KiloClawInternalClient, KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { KiloClawUserClient } from '@/lib/kiloclaw/kiloclaw-user-client';
import { encryptKiloClawSecret } from '@/lib/kiloclaw/encryption';
import {
  ALL_SECRET_FIELD_KEYS,
  FIELD_KEY_TO_ENTRY,
  validateFieldValue,
  type SecretFieldKey,
} from '@kilocode/kiloclaw-secret-catalog';
import {
  KILOCLAW_API_URL,
  STRIPE_KILOCLAW_EARLYBIRD_PRICE_ID,
  STRIPE_KILOCLAW_EARLYBIRD_COUPON_ID,
  STRIPE_KILOCLAW_BILLING_START,
  KILOCLAW_BILLING_ENFORCEMENT,
} from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import {
  kiloclaw_version_pins,
  kiloclaw_image_catalog,
  kiloclaw_earlybird_purchases,
  kiloclaw_subscriptions,
  kiloclaw_instances,
} from '@kilocode/db/schema';
import { and, eq, desc, sql } from 'drizzle-orm';
import { sentryLogger } from '@/lib/utils.server';
import type { KiloClawDashboardStatus, KiloCodeConfigResponse } from '@/lib/kiloclaw/types';
import {
  ensureActiveInstance,
  markActiveInstanceDestroyed,
  restoreDestroyedInstance,
} from '@/lib/kiloclaw/instance-registry';
import { client as stripe } from '@/lib/stripe-client';
import { APP_URL } from '@/lib/constants';
import { getRewardfulReferral } from '@/lib/rewardful';
import { clawAccessProcedure } from '@/lib/kiloclaw/access-gate';
import { getStripePriceIdForClawPlan } from '@/lib/kiloclaw/stripe-price-ids.server';
import {
  KILOCLAW_EARLYBIRD_EXPIRY_DATE,
  KILOCLAW_TRIAL_DURATION_DAYS,
} from '@/lib/kiloclaw/constants';
import type { ClawBillingStatus } from '@/app/(app)/claw/components/billing/billing-types';

/**
 * Error codes whose messages may contain raw internal details (e.g. filesystem
 * paths) and should NOT be forwarded to the client.
 */
const UNSAFE_ERROR_CODES = new Set(['config_read_failed', 'config_replace_failed']);

/**
 * Map KiloClawApiError responses to TRPCErrors for file operations.
 * Always throws — call as `handleFileOperationError(err, 'read file')`.
 */
function handleFileOperationError(err: unknown, operation: string): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof KiloClawApiError && err.statusCode === 404) {
    const { code, message } = getKiloClawApiErrorPayload(err);
    throw new TRPCError({
      code: 'NOT_FOUND',
      message:
        code === 'controller_route_unavailable'
          ? `Instance needs redeploy to support ${operation}`
          : (message ?? `Failed to ${operation}`),
    });
  }
  if (err instanceof KiloClawApiError && err.statusCode === 400) {
    const { message, code } = getKiloClawApiErrorPayload(err);
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        code && UNSAFE_ERROR_CODES.has(code)
          ? `Failed to ${operation}`
          : (message ?? `Failed to ${operation}`),
    });
  }
  if (err instanceof KiloClawApiError && err.statusCode === 409) {
    const { message, code } = getKiloClawApiErrorPayload(err);
    throw new TRPCError({
      code: 'CONFLICT',
      message: message ?? 'File was modified externally',
      cause: code ? new UpstreamApiError(code) : undefined,
    });
  }
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message:
      err instanceof KiloClawApiError
        ? (getKiloClawApiErrorPayload(err).message ?? `Failed to ${operation}`)
        : `Failed to ${operation}`,
  });
}

function getKiloClawApiErrorPayload(err: KiloClawApiError): { message?: string; code?: string } {
  if (!err.responseBody) return {};

  try {
    const parsed = JSON.parse(err.responseBody) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }

    const code = 'code' in parsed && typeof parsed.code === 'string' ? parsed.code : undefined;
    const message =
      'error' in parsed && typeof parsed.error === 'string' && parsed.error.length > 0
        ? parsed.error
        : undefined;

    return {
      message: code && UNSAFE_ERROR_CODES.has(code) ? undefined : message,
      code,
    };
  } catch {
    return {};
  }
}

const kilocodeDefaultModelSchema = z
  .string()
  .regex(
    /^kilocode\/[^/]+\/.+$/,
    'kilocodeDefaultModel must start with kilocode/ and include a provider'
  );

// TODO: Replace with catalog-driven schema. This hardcoded list must be kept
// in sync with @kilocode/kiloclaw-secret-catalog channel entries. Any new
// catalog channel entry will render in the UI but be silently stripped here
// by Zod. Migrate provision path to use patchSecrets pipeline instead.
const channelsSchema = z
  .object({
    telegramBotToken: z.string().optional(),
    discordBotToken: z.string().optional(),
    slackBotToken: z.string().optional(),
    slackAppToken: z.string().optional(),
  })
  .optional();

const updateConfigSchema = z.object({
  envVars: z.record(z.string(), z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  channels: channelsSchema,
  kilocodeDefaultModel: kilocodeDefaultModelSchema.nullable().optional(),
});

const updateKiloCodeConfigSchema = z.object({
  kilocodeDefaultModel: kilocodeDefaultModelSchema.nullable().optional(),
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

  // Check if the user has a version pin
  const [pin] = await db
    .select({ image_tag: kiloclaw_version_pins.image_tag })
    .from(kiloclaw_version_pins)
    .where(eq(kiloclaw_version_pins.user_id, user.id))
    .limit(1);
  const pinnedImageTag = pin?.image_tag;

  const client = new KiloClawInternalClient();
  return client.provision(user.id, {
    envVars: input.envVars,
    encryptedSecrets,
    channels: buildWorkerChannels(input.channels),
    kilocodeApiKey,
    kilocodeApiKeyExpiresAt,
    kilocodeDefaultModel: input.kilocodeDefaultModel ?? undefined,
    pinnedImageTag,
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
const logBillingError = sentryLogger('kiloclaw-billing', 'error');

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

/**
 * Ensure the user has billing access for provisioning: auto-create a trial row
 * for new users, allow active/past_due/trialing/earlybird, and reject otherwise.
 * Used by both `provision` and its backward-compatible alias `updateConfig`.
 *
 * Earlybird is checked first so earlybird purchasers never get an accidental
 * trial row, and expired earlybird users cannot regain access by provisioning.
 */
async function ensureProvisionAccess(userId: string): Promise<void> {
  // Check earlybird before anything else — active earlybird grants access,
  // expired earlybird must not fall through to the trial bootstrap.
  const [earlybird] = await db
    .select({ id: kiloclaw_earlybird_purchases.id })
    .from(kiloclaw_earlybird_purchases)
    .where(eq(kiloclaw_earlybird_purchases.user_id, userId))
    .limit(1);
  if (earlybird) {
    if (new Date(KILOCLAW_EARLYBIRD_EXPIRY_DATE) > new Date()) return;
    // Expired earlybird — fall through to subscription check, but must not
    // auto-create a trial (spec: user must manually subscribe).
  }

  const [existing] = await db
    .select({
      status: kiloclaw_subscriptions.status,
      trial_ends_at: kiloclaw_subscriptions.trial_ends_at,
      suspended_at: kiloclaw_subscriptions.suspended_at,
    })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.user_id, userId))
    .limit(1);

  if (!existing && !earlybird) {
    // New user with no earlybird purchase — start trial.
    // Use onConflictDoNothing so concurrent requests (e.g. double-submit)
    // don't fail on the unique user_id constraint.
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + KILOCLAW_TRIAL_DURATION_DAYS * 86_400_000);
    await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: userId,
        plan: 'trial',
        status: 'trialing',
        trial_started_at: now.toISOString(),
        trial_ends_at: trialEndsAt.toISOString(),
      })
      .onConflictDoNothing({ target: kiloclaw_subscriptions.user_id });
    return;
  }

  if (existing) {
    // Mirror requireKiloClawAccess: active always passes; past_due passes only
    // until the billing lifecycle cron sets suspended_at.
    if (existing.status === 'active') return;
    if (existing.status === 'past_due' && !existing.suspended_at) return;
    if (
      existing.status === 'trialing' &&
      existing.trial_ends_at &&
      new Date(existing.trial_ends_at) > new Date()
    ) {
      return;
    }
  }

  if (!KILOCLAW_BILLING_ENFORCEMENT) return;

  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'Your trial has expired. Please subscribe to continue using KiloClaw.',
  });
}

export const kiloclawRouter = createTRPCRouter({
  serviceDegraded: baseProcedure.query(async () => {
    return fetchKiloClawServiceDegraded();
  }),

  latestVersion: baseProcedure.query(async () => {
    const client = new KiloClawInternalClient();
    return client.getLatestVersion();
  }),

  getStatus: baseProcedure.query(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    const status = await client.getStatus(ctx.user.id);
    const workerUrl = KILOCLAW_API_URL || 'https://claw.kilo.ai';

    return { ...status, workerUrl } satisfies KiloClawDashboardStatus;
  }),

  // Instance lifecycle
  start: clawAccessProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.start(ctx.user.id);
  }),

  stop: clawAccessProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.stop(ctx.user.id);
  }),

  destroy: clawAccessProcedure.mutation(async ({ ctx }) => {
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
    await ensureProvisionAccess(ctx.user.id);
    return provisionInstance(ctx.user, input);
  }),

  patchConfig: clawAccessProcedure
    .input(updateKiloCodeConfigSchema)
    .mutation(async ({ ctx, input }) => {
      return patchConfig(ctx.user, input);
    }),

  // Backward-compatible alias — uses the same trial-bootstrap flow as provision
  // so first-time callers can create a trial row (clawAccessProcedure would reject them).
  updateConfig: baseProcedure.input(updateConfigSchema).mutation(async ({ ctx, input }) => {
    await ensureProvisionAccess(ctx.user.id);
    return provisionInstance(ctx.user, input);
  }),

  updateKiloCodeConfig: clawAccessProcedure
    .input(updateKiloCodeConfigSchema)
    .mutation(async ({ ctx, input }) => {
      return patchConfig(ctx.user, input);
    }),

  patchChannels: clawAccessProcedure.input(patchChannelsSchema).mutation(async ({ ctx, input }) => {
    const client = new KiloClawInternalClient();
    return client.patchChannels(ctx.user.id, {
      channels: buildWorkerChannelsPatch(input),
    });
  }),

  /**
   * Generic secret patch — catalog-driven replacement for patchChannels.
   * Validates keys against the secret catalog, enforces allFieldsRequired,
   * validates values against catalog patterns, encrypts, and forwards to worker.
   */
  patchSecrets: clawAccessProcedure
    .input(
      z.object({
        secrets: z
          .record(z.string(), z.string().max(500).nullable())
          .refine(obj => Object.keys(obj).every(k => ALL_SECRET_FIELD_KEYS.has(k)), {
            message: 'Unknown secret field key',
          }),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const secrets = input.secrets as Partial<Record<SecretFieldKey, string | null>>;

      // 1. allFieldsRequired is enforced by the DO on post-merge state (not here),
      //    so single-field rotations work when the other field is already stored.

      // 2. Validate non-null values against catalog patterns + enforce per-field maxLength
      for (const [key, value] of Object.entries(secrets)) {
        if (value === null) continue;

        const entry = FIELD_KEY_TO_ENTRY.get(key);
        const field = entry?.fields.find(f => f.key === key);

        // Enforce per-field maxLength from catalog (falls back to 500 from zod schema above)
        if (field?.maxLength != null && value.length > field.maxLength) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `${field.label} exceeds maximum length of ${field.maxLength} characters`,
          });
        }

        if (!validateFieldValue(value, field?.validationPattern)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: field?.validationMessage ?? `Invalid value for ${key}`,
          });
        }
      }

      // 3. Encrypt non-null values
      const encryptedPatch: Partial<
        Record<SecretFieldKey, ReturnType<typeof encryptKiloClawSecret> | null>
      > = {};
      for (const [key, value] of Object.entries(secrets)) {
        encryptedPatch[key as SecretFieldKey] =
          value === null ? null : encryptKiloClawSecret(value);
      }

      // 4. Forward to worker — translate 4xx responses into TRPCErrors
      const client = new KiloClawInternalClient();
      try {
        return await client.patchSecrets(ctx.user.id, { secrets: encryptedPatch });
      } catch (err) {
        if (err instanceof KiloClawApiError && err.statusCode >= 400 && err.statusCode < 500) {
          // Extract message from worker response body (JSON or plain text)
          let message = `Secret patch failed (${err.statusCode})`;
          try {
            const parsed = JSON.parse(err.responseBody);
            if (typeof parsed.error === 'string') message = parsed.error;
            else if (typeof parsed.message === 'string') message = parsed.message;
          } catch {
            if (err.responseBody) message = err.responseBody;
          }
          throw new TRPCError({ code: 'BAD_REQUEST', message });
        }
        throw err;
      }
    }),

  // User-facing (user client -- forwards user's short-lived JWT)
  getConfig: baseProcedure.query(async ({ ctx }) => {
    const client = new KiloClawUserClient(
      generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes })
    );
    return client.getConfig({ userId: ctx.user.id });
  }),

  restartMachine: clawAccessProcedure
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
      return client.restartMachine(input?.imageTag ? { imageTag: input.imageTag } : undefined, {
        userId: ctx.user.id,
      });
    }),

  listPairingRequests: clawAccessProcedure
    .input(z.object({ refresh: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const client = new KiloClawInternalClient();
      return client.listPairingRequests(ctx.user.id, input?.refresh);
    }),

  approvePairingRequest: clawAccessProcedure
    .input(z.object({ channel: z.string().min(1), code: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const client = new KiloClawInternalClient();
      return client.approvePairingRequest(ctx.user.id, input.channel, input.code);
    }),

  listDevicePairingRequests: clawAccessProcedure
    .input(z.object({ refresh: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const client = new KiloClawInternalClient();
      return client.listDevicePairingRequests(ctx.user.id, input?.refresh);
    }),

  approveDevicePairingRequest: clawAccessProcedure
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

  restartOpenClaw: clawAccessProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.restartGatewayProcess(ctx.user.id);
  }),

  runDoctor: clawAccessProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.runDoctor(ctx.user.id);
  }),

  restoreConfig: clawAccessProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.restoreConfig(ctx.user.id);
  }),

  getGoogleSetupCommand: clawAccessProcedure.query(({ ctx }) => {
    // Short-lived token — the user should run the setup command promptly.
    // Regenerated on each page load, so 1 hour is sufficient.
    const token = generateApiToken(ctx.user, undefined, {
      expiresIn: TOKEN_EXPIRY.oneHour,
    });
    const isDev = process.env.NODE_ENV === 'development';
    const imageTag = isDev ? ':dev' : ':latest';
    const workerFlag = isDev ? ' --worker-url=http://localhost:8795' : '';
    const gmailPushFlag = isDev ? ' --gmail-push-worker-url=${GMAIL_PUSH_WORKER_URL}' : '';
    const imageUrl = `ghcr.io/kilo-org/google-setup${imageTag}`;
    return {
      command: `docker pull ${imageUrl} && docker run -it --network host ${imageUrl} --token="${token}"${workerFlag}${gmailPushFlag}`,
    };
  }),

  disconnectGoogle: clawAccessProcedure.mutation(async ({ ctx }) => {
    const client = new KiloClawInternalClient();
    return client.clearGoogleCredentials(ctx.user.id);
  }),

  setGmailNotifications: baseProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const client = new KiloClawInternalClient();
      try {
        if (input.enabled) {
          return await client.enableGmailNotifications(ctx.user.id);
        }
        return await client.disableGmailNotifications(ctx.user.id);
      } catch (err) {
        if (err instanceof KiloClawApiError && err.statusCode >= 400 && err.statusCode < 500) {
          let message = `Failed to update Gmail notifications (${err.statusCode})`;
          try {
            const parsed = JSON.parse(err.responseBody);
            if (typeof parsed.error === 'string') message = parsed.error;
            else if (typeof parsed.message === 'string') message = parsed.message;
          } catch {
            if (err.responseBody) message = err.responseBody;
          }
          throw new TRPCError({ code: 'BAD_REQUEST', message });
        }
        throw err;
      }
    }),

  getEarlybirdStatus: baseProcedure
    .output(z.object({ purchased: z.boolean() }))
    .query(async ({ ctx }) => {
      const rows = await db
        .select({ id: kiloclaw_earlybird_purchases.id })
        .from(kiloclaw_earlybird_purchases)
        .where(eq(kiloclaw_earlybird_purchases.user_id, ctx.user.id))
        .limit(1);
      return { purchased: rows.length > 0 };
    }),

  createEarlybirdCheckoutSession: baseProcedure
    .output(z.object({ url: z.url().nullable() }))
    .mutation(async ({ ctx }) => {
      const existing = await db
        .select({ id: kiloclaw_earlybird_purchases.id })
        .from(kiloclaw_earlybird_purchases)
        .where(eq(kiloclaw_earlybird_purchases.user_id, ctx.user.id))
        .limit(1);

      if (existing.length > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You have already purchased the early bird offer.',
        });
      }

      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Missing Stripe customer for user.',
        });
      }

      if (!STRIPE_KILOCLAW_EARLYBIRD_PRICE_ID) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Early bird pricing is not configured.',
        });
      }

      const rewardfulReferral = await getRewardfulReferral();

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: stripeCustomerId,
        ...(rewardfulReferral && { client_reference_id: rewardfulReferral }),
        billing_address_collection: 'required',
        line_items: [{ price: STRIPE_KILOCLAW_EARLYBIRD_PRICE_ID, quantity: 1 }],
        ...(STRIPE_KILOCLAW_EARLYBIRD_COUPON_ID
          ? { discounts: [{ coupon: STRIPE_KILOCLAW_EARLYBIRD_COUPON_ID }] }
          : { allow_promotion_codes: true }),
        customer_update: {
          name: 'auto',
          address: 'auto',
        },
        tax_id_collection: {
          enabled: true,
          required: 'never',
        },
        payment_intent_data: {
          metadata: {
            type: 'kiloclaw-earlybird',
            kiloUserId: ctx.user.id,
          },
        },
        success_url: `${APP_URL}/claw?earlybird_checkout=success`,
        cancel_url: `${APP_URL}/claw/earlybird?checkout=cancelled`,
        metadata: {
          type: 'kiloclaw-earlybird',
          kiloUserId: ctx.user.id,
        },
      });

      return { url: typeof session.url === 'string' ? session.url : null };
    }),

  // User version pinning endpoints
  listAvailableVersions: baseProcedure
    .input(
      z.object({
        offset: z.number().min(0).default(0),
        limit: z.number().min(1).max(100).default(25),
      })
    )
    .query(async ({ input }) => {
      const { offset, limit } = input;

      // Subquery: for each version+variant, pick the most recently published image tag
      const latestPerVersion = db
        .selectDistinctOn(
          [kiloclaw_image_catalog.openclaw_version, kiloclaw_image_catalog.variant],
          {
            openclaw_version: kiloclaw_image_catalog.openclaw_version,
            variant: kiloclaw_image_catalog.variant,
            image_tag: kiloclaw_image_catalog.image_tag,
            description: kiloclaw_image_catalog.description,
            published_at: kiloclaw_image_catalog.published_at,
          }
        )
        .from(kiloclaw_image_catalog)
        .where(eq(kiloclaw_image_catalog.status, 'available'))
        .orderBy(
          kiloclaw_image_catalog.openclaw_version,
          kiloclaw_image_catalog.variant,
          desc(kiloclaw_image_catalog.published_at)
        )
        .as('latest_per_version');

      const [items, countResult] = await Promise.all([
        db
          .select()
          .from(latestPerVersion)
          .orderBy(desc(latestPerVersion.published_at))
          .offset(offset)
          .limit(limit),
        db.select({ count: sql<number>`COUNT(*)::int` }).from(latestPerVersion),
      ]);

      const totalCount = countResult[0]?.count ?? 0;

      return {
        items,
        pagination: {
          offset,
          limit,
          totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      };
    }),

  getMyPin: baseProcedure.query(async ({ ctx }) => {
    const [result] = await db
      .select({
        pin: kiloclaw_version_pins,
        openclaw_version: kiloclaw_image_catalog.openclaw_version,
        variant: kiloclaw_image_catalog.variant,
      })
      .from(kiloclaw_version_pins)
      .leftJoin(
        kiloclaw_image_catalog,
        eq(kiloclaw_version_pins.image_tag, kiloclaw_image_catalog.image_tag)
      )
      // Intentionally not joining pinned_by user — avoid leaking admin email to end users
      .where(eq(kiloclaw_version_pins.user_id, ctx.user.id))
      .limit(1);

    if (!result) return null;

    return {
      ...result.pin,
      openclaw_version: result.openclaw_version,
      variant: result.variant,
    };
  }),

  setMyPin: clawAccessProcedure
    .input(
      z.object({
        imageTag: z.string().min(1),
        reason: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify the version exists and is available
      // Note: There is a small TOCTOU window between this check and the insert below.
      // Worst case: a user pins to a version disabled milliseconds before. The FK constraint
      // on image_tag ensures referential integrity, and the status check is best-effort.
      const [version] = await db
        .select()
        .from(kiloclaw_image_catalog)
        .where(eq(kiloclaw_image_catalog.image_tag, input.imageTag))
        .limit(1);

      if (!version) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Image tag '${input.imageTag}' not found in catalog`,
        });
      }

      if (version.status !== 'available') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot pin to version with status '${version.status}'. Only 'available' versions can be pinned.`,
        });
      }

      // Prevent users from overwriting admin-set pins
      const [existingPin] = await db
        .select({ pinned_by: kiloclaw_version_pins.pinned_by })
        .from(kiloclaw_version_pins)
        .where(eq(kiloclaw_version_pins.user_id, ctx.user.id))
        .limit(1);

      if (existingPin && existingPin.pinned_by !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            'Your version is pinned by an admin. Contact your Kilo admin to change or remove the pin.',
        });
      }

      let result: typeof kiloclaw_version_pins.$inferSelect | undefined;
      try {
        [result] = await db
          .insert(kiloclaw_version_pins)
          .values({
            user_id: ctx.user.id,
            image_tag: input.imageTag,
            pinned_by: ctx.user.id,
            reason: input.reason ?? null,
          })
          .onConflictDoUpdate({
            target: kiloclaw_version_pins.user_id,
            set: {
              image_tag: input.imageTag,
              pinned_by: ctx.user.id,
              reason: input.reason ?? null,
              updated_at: new Date().toISOString(),
            },
          })
          .returning();
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('foreign key')) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Image tag '${input.imageTag}' not found in catalog`,
          });
        }
        throw err;
      }

      if (!result) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create pin' });
      }

      return result;
    }),

  removeMyPin: clawAccessProcedure.mutation(async ({ ctx }) => {
    // Atomically delete only self-set pins — the WHERE clause enforces the admin-pin guard
    // so there's no TOCTOU race between checking pinned_by and deleting.
    const [deleted] = await db
      .delete(kiloclaw_version_pins)
      .where(
        and(
          eq(kiloclaw_version_pins.user_id, ctx.user.id),
          eq(kiloclaw_version_pins.pinned_by, ctx.user.id)
        )
      )
      .returning();

    if (!deleted) {
      // Check if a pin exists at all — if so, it's admin-set
      const [existingPin] = await db
        .select({ pinned_by: kiloclaw_version_pins.pinned_by })
        .from(kiloclaw_version_pins)
        .where(eq(kiloclaw_version_pins.user_id, ctx.user.id))
        .limit(1);

      if (existingPin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Your version is pinned by an admin. Contact your Kilo admin to remove the pin.',
        });
      }

      throw new TRPCError({ code: 'NOT_FOUND', message: 'No pin found for your account' });
    }

    return { success: true };
  }),

  fileTree: clawAccessProcedure.query(async ({ ctx }) => {
    try {
      const client = new KiloClawInternalClient();
      const result = await client.getFileTree(ctx.user.id);
      return result.tree;
    } catch (err) {
      handleFileOperationError(err, 'fetch file tree');
    }
  }),

  readFile: clawAccessProcedure
    .input(z.object({ path: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        const client = new KiloClawInternalClient();
        return await client.readFile(ctx.user.id, input.path);
      } catch (err) {
        handleFileOperationError(err, 'read file');
      }
    }),

  writeFile: clawAccessProcedure
    .input(
      z.object({
        path: z.string().min(1),
        content: z.string(),
        etag: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const client = new KiloClawInternalClient();
        let content = input.content;

        if (input.path === 'openclaw.json') {
          let userConfig: unknown;
          try {
            userConfig = JSON.parse(content);
          } catch {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'openclaw.json must be valid JSON',
            });
          }
          if (typeof userConfig !== 'object' || userConfig === null || Array.isArray(userConfig)) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'openclaw.json must be a JSON object',
            });
          }
          content = JSON.stringify(userConfig, null, 2);
        }

        return await client.writeFile(ctx.user.id, input.path, content, input.etag);
      } catch (err) {
        handleFileOperationError(err, 'write file');
      }
    }),

  patchOpenclawConfig: clawAccessProcedure
    .input(z.object({ patch: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const client = new KiloClawInternalClient();
        return await client.patchOpenclawConfig(ctx.user.id, input.patch);
      } catch (err) {
        handleFileOperationError(err, 'patch openclaw config');
      }
    }),

  // ── Billing endpoints ────────────────────────────────────────────────

  getBillingStatus: baseProcedure.query(async ({ ctx }) => {
    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, ctx.user.id))
      .limit(1);

    const [earlybird] = await db
      .select({ id: kiloclaw_earlybird_purchases.id })
      .from(kiloclaw_earlybird_purchases)
      .where(eq(kiloclaw_earlybird_purchases.user_id, ctx.user.id))
      .limit(1);

    const [activeInstance] = await db
      .select({
        id: kiloclaw_instances.id,
        destroyed_at: kiloclaw_instances.destroyed_at,
      })
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.user_id, ctx.user.id))
      .orderBy(desc(kiloclaw_instances.created_at))
      .limit(1);

    const earlybirdExpiresAt = KILOCLAW_EARLYBIRD_EXPIRY_DATE;
    const earlybirdDaysRemaining = earlybird
      ? Math.ceil((new Date(earlybirdExpiresAt).getTime() - Date.now()) / 86_400_000)
      : 0;

    const now = new Date();

    // Compute hasAccess — when enforcement is off, always grant access
    let hasAccess = !KILOCLAW_BILLING_ENFORCEMENT;
    let accessReason: 'trial' | 'subscription' | 'earlybird' | null = null;

    if (sub?.status === 'active' || (sub?.status === 'past_due' && !sub.suspended_at)) {
      hasAccess = true;
      accessReason = 'subscription';
    } else if (
      sub?.status === 'trialing' &&
      sub.trial_ends_at &&
      new Date(sub.trial_ends_at) > now
    ) {
      hasAccess = true;
      accessReason = 'trial';
    } else if (earlybird && new Date(earlybirdExpiresAt) > now) {
      hasAccess = true;
      accessReason = 'earlybird';
    }

    const trialData =
      sub?.status === 'trialing' || (sub?.trial_started_at && sub?.trial_ends_at)
        ? {
            startedAt: sub.trial_started_at ?? sub.created_at,
            endsAt: sub.trial_ends_at ?? '',
            daysRemaining: sub.trial_ends_at
              ? Math.max(
                  0,
                  Math.floor((new Date(sub.trial_ends_at).getTime() - now.getTime()) / 86_400_000)
                )
              : 0,
            expired: sub.trial_ends_at ? new Date(sub.trial_ends_at) <= now : false,
          }
        : null;

    const subscriptionData =
      sub && sub.plan !== 'trial' && sub.status !== 'trialing' && sub.stripe_subscription_id
        ? {
            plan: sub.plan,
            status: sub.status,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            currentPeriodEnd: sub.current_period_end ?? '',
            commitEndsAt: sub.commit_ends_at,
            scheduledPlan: sub.scheduled_plan,
            scheduledBy: sub.scheduled_by,
          }
        : null;

    const earlybirdData = earlybird
      ? {
          purchased: true,
          expiresAt: earlybirdExpiresAt,
          daysRemaining: earlybirdDaysRemaining,
        }
      : null;

    // Determine instance status from KiloClaw service
    let instanceData: ClawBillingStatus['instance'] = null;
    if (activeInstance) {
      const isDestroyed = activeInstance.destroyed_at !== null;
      instanceData = {
        exists: !isDestroyed,
        status: null,
        suspendedAt: sub?.suspended_at ?? null,
        destructionDeadline: sub?.destruction_deadline ?? null,
        destroyed: isDestroyed,
      };
    }

    return {
      hasAccess,
      accessReason,
      trialEligible: !activeInstance && !sub && !earlybird,
      trial: trialData,
      subscription: subscriptionData,
      earlybird: earlybirdData,
      instance: instanceData,
    } satisfies ClawBillingStatus;
  }),

  createSubscriptionCheckout: baseProcedure
    .input(z.object({ plan: z.enum(['commit', 'standard']) }))
    .mutation(async ({ ctx, input }) => {
      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer for user.' });
      }

      // Reject checkout if any non-ended subscription exists (active, past_due, unpaid).
      // The trialing status is exempted so trial users can convert to paid.
      const [existing] = await db
        .select({ status: kiloclaw_subscriptions.status })
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.user_id, ctx.user.id))
        .limit(1);

      if (existing && existing.status !== 'canceled' && existing.status !== 'trialing') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You already have an active subscription.',
        });
      }

      // Guard against duplicate Stripe subscriptions from concurrent checkouts.
      // The local DB check above exempts trialing rows, so a user could open
      // multiple Checkout Sessions before the first webhook flips the row to active.
      // We check for both completed subscriptions and open checkout sessions:
      // - Active/trialing subscriptions catch the case where a prior checkout completed.
      // - Open checkout sessions catch the race where a parallel request just
      //   created a session but the user hasn't completed it yet, preventing
      //   multiple pending sessions from leading to duplicate subscriptions.
      const [activeSubs, trialingSubs, openSessions] = await Promise.all([
        stripe.subscriptions.list({ customer: stripeCustomerId, status: 'active', limit: 10 }),
        stripe.subscriptions.list({ customer: stripeCustomerId, status: 'trialing', limit: 10 }),
        stripe.checkout.sessions.list({ customer: stripeCustomerId, status: 'open', limit: 10 }),
      ]);
      const hasActiveKiloClawSub = [...activeSubs.data, ...trialingSubs.data].some(
        s => s.metadata.type === 'kiloclaw'
      );
      if (hasActiveKiloClawSub) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You already have an active subscription.',
        });
      }
      // Best-effort cleanup: expire stale open checkout sessions so the user
      // can start fresh (e.g. they started checkout, closed the tab, and came
      // back to retry). Errors are swallowed because a session may already be
      // expired or completed by the time we call expire() — either way the
      // stale session is no longer open, which is the goal.
      //
      // NOTE: This does not prevent two concurrent requests from both reaching
      // sessions.create(). That race is inherent to any read-then-write
      // pattern against the Stripe API and cannot be closed without an
      // external lock. Duplicate open checkout sessions are tolerable: each
      // requires independent user action to complete, and the subscription-
      // level guard above (hasActiveKiloClawSub) prevents the real harm —
      // duplicate subscriptions.
      const staleKiloClawSessions = openSessions.data.filter(s => s.metadata?.type === 'kiloclaw');
      await Promise.all(
        staleKiloClawSessions.map(s =>
          stripe.checkout.sessions.expire(s.id).catch(() => {
            // Swallow — session is already expired, completed, or otherwise
            // no longer open. The goal (clearing stale sessions) is met.
          })
        )
      );

      const priceId = getStripePriceIdForClawPlan(input.plan);

      const rewardfulReferral = await getRewardfulReferral();

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeCustomerId,
        ...(rewardfulReferral && { client_reference_id: rewardfulReferral }),
        allow_promotion_codes: input.plan === 'standard',
        billing_address_collection: 'required',
        line_items: [{ price: priceId, quantity: 1 }],
        customer_update: { name: 'auto', address: 'auto' },
        tax_id_collection: { enabled: true, required: 'never' },
        success_url: `${APP_URL}/payments/kiloclaw/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}/claw?checkout=cancelled`,
        subscription_data: {
          metadata: { type: 'kiloclaw', plan: input.plan, kiloUserId: ctx.user.id },
          ...(STRIPE_KILOCLAW_BILLING_START &&
          Date.now() < new Date(STRIPE_KILOCLAW_BILLING_START).getTime()
            ? { trial_end: Math.floor(new Date(STRIPE_KILOCLAW_BILLING_START).getTime() / 1000) }
            : {}),
        },
        metadata: { type: 'kiloclaw', plan: input.plan, kiloUserId: ctx.user.id },
      });

      return { url: typeof session.url === 'string' ? session.url : null };
    }),

  cancelSubscription: baseProcedure.mutation(async ({ ctx }) => {
    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, ctx.user.id))
      .limit(1);

    if (!sub?.stripe_subscription_id || sub.status !== 'active') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'No active subscription to cancel.' });
    }

    if (sub.cancel_at_period_end) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Subscription is already set to cancel.',
      });
    }

    // If there's a pending schedule, release it first.
    // Only clear the local pointer after release succeeds or the schedule is
    // already released/canceled, so Stripe and local state stay in sync.
    if (sub.stripe_schedule_id) {
      try {
        await stripe.subscriptionSchedules.release(sub.stripe_schedule_id);
      } catch (releaseError) {
        // If the schedule was already released/canceled, Stripe returns an error
        // with status 400 and a message about the schedule not being active.
        // In that case we should still clear our local pointer.
        const msg = releaseError instanceof Error ? releaseError.message : String(releaseError);
        const alreadyInactive =
          msg.includes('not active') || msg.includes('released') || msg.includes('canceled');
        if (!alreadyInactive) {
          logBillingError('Failed to release subscription schedule — aborting cancellation', {
            user_id: ctx.user.id,
            schedule_id: sub.stripe_schedule_id,
            error: msg,
          });
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Unable to cancel: failed to release pending plan schedule. Please try again.',
          });
        }
      }
    }

    // Set cancel_at_period_end in Stripe BEFORE clearing local schedule fields.
    // If this Stripe call fails, the schedule was already released in Stripe but
    // local state still references it, so reactivateSubscription can recreate it.
    await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });

    // Both Stripe calls succeeded — now persist all local changes together.
    await db
      .update(kiloclaw_subscriptions)
      .set({
        cancel_at_period_end: true,
        ...(sub.stripe_schedule_id
          ? { stripe_schedule_id: null, scheduled_plan: null, scheduled_by: null }
          : {}),
      })
      .where(eq(kiloclaw_subscriptions.user_id, ctx.user.id));

    return { success: true };
  }),

  reactivateSubscription: baseProcedure.mutation(async ({ ctx }) => {
    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, ctx.user.id))
      .limit(1);

    if (!sub?.stripe_subscription_id || !sub.cancel_at_period_end) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No pending cancellation to reactivate.',
      });
    }

    await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: false });
    await db
      .update(kiloclaw_subscriptions)
      .set({ cancel_at_period_end: false })
      .where(eq(kiloclaw_subscriptions.user_id, ctx.user.id));

    return { success: true };
  }),

  switchPlan: baseProcedure
    .input(z.object({ toPlan: z.enum(['commit', 'standard']) }))
    .mutation(async ({ ctx, input }) => {
      const [sub] = await db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.user_id, ctx.user.id))
        .limit(1);

      if (!sub?.stripe_subscription_id || sub.status !== 'active') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No active subscription to switch.' });
      }

      if (sub.plan === input.toPlan) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Already on this plan.' });
      }

      if (sub.plan !== 'commit' && sub.plan !== 'standard') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot switch from a trial plan.' });
      }

      if (sub.stripe_schedule_id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A plan switch is already pending. Cancel it before requesting a new one.',
        });
      }

      const targetPriceId = getStripePriceIdForClawPlan(input.toPlan);
      const currentPriceId = getStripePriceIdForClawPlan(sub.plan);

      // Create schedule for plan transition at period end.
      // from_subscription creates a schedule with one phase matching the current billing period.
      // We must preserve that phase's start/end dates so the switch happens at renewal, not immediately.
      const schedule = await stripe.subscriptionSchedules.create({
        from_subscription: sub.stripe_subscription_id,
      });

      const currentPhase = schedule.phases[0];
      if (!currentPhase) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Stripe schedule has no current phase.',
        });
      }

      // Both directions use a 2-phase schedule: current plan until period end,
      // then the target plan (open-ended, end_behavior: 'release'). When the
      // final phase starts, Stripe releases the schedule and the subscription
      // continues on the new price. The plan change is picked up by
      // subscription.updated via detectPlanFromSubscription, and the schedule
      // release event clears the tracking fields.
      await stripe.subscriptionSchedules.update(schedule.id, {
        end_behavior: 'release',
        phases: [
          {
            items: [{ price: currentPriceId }],
            start_date: currentPhase.start_date,
            end_date: currentPhase.end_date,
          },
          { items: [{ price: targetPriceId }] },
        ],
      });

      await db
        .update(kiloclaw_subscriptions)
        .set({
          stripe_schedule_id: schedule.id,
          scheduled_plan: input.toPlan,
          scheduled_by: 'user',
        })
        .where(eq(kiloclaw_subscriptions.user_id, ctx.user.id));

      return { success: true };
    }),

  cancelPlanSwitch: baseProcedure.mutation(async ({ ctx }) => {
    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, ctx.user.id))
      .limit(1);

    if (!sub?.stripe_schedule_id) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'No pending plan switch to cancel.' });
    }

    // Only user-initiated plan switches may be canceled.
    if (sub.scheduled_by !== 'user') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No user-initiated plan switch to cancel.',
      });
    }

    await stripe.subscriptionSchedules.release(sub.stripe_schedule_id);
    await db
      .update(kiloclaw_subscriptions)
      .set({ stripe_schedule_id: null, scheduled_plan: null, scheduled_by: null })
      .where(eq(kiloclaw_subscriptions.user_id, ctx.user.id));

    return { success: true };
  }),

  createBillingPortalSession: baseProcedure.mutation(async ({ ctx }) => {
    const stripeCustomerId = ctx.user.stripe_customer_id;
    if (!stripeCustomerId) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${APP_URL}/claw`,
    });

    return { url: session.url };
  }),
});

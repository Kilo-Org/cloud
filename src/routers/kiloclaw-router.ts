import 'server-only';

import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
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
} from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import {
  kiloclaw_version_pins,
  kiloclaw_image_catalog,
  kiloclaw_earlybird_purchases,
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

const kilocodeDefaultModelSchema = z
  .string()
  .regex(
    /^kilocode\/[^/]+\/.+$/,
    'kilocodeDefaultModel must start with kilocode/ and include a provider'
  );

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

const provisionSchema = z.object({
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
  provision: baseProcedure.input(provisionSchema).mutation(async ({ ctx, input }) => {
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

  /**
   * Generic secret patch — catalog-driven replacement for patchChannels.
   * Validates keys against the secret catalog, enforces allFieldsRequired,
   * validates values against catalog patterns, encrypts, and forwards to worker.
   */
  patchSecrets: baseProcedure
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

  setMyPin: baseProcedure
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

      let result;
      try {
        [result] = await db
          .insert(kiloclaw_version_pins)
          .values({
            user_id: ctx.user.id,
            image_tag: input.imageTag,
            pinned_by: ctx.user.id, // User is pinning themselves
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

  removeMyPin: baseProcedure.mutation(async ({ ctx }) => {
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
});

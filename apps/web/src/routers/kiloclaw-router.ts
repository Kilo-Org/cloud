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
  MAX_CUSTOM_SECRET_VALUE_LENGTH,
  validateFieldValue,
  getEntriesByCategory,
  isValidCustomSecretKey,
  isValidConfigPath,
} from '@kilocode/kiloclaw-secret-catalog';
import { KILOCLAW_API_URL } from '@/lib/config.server';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import {
  kiloclaw_version_pins,
  kiloclaw_image_catalog,
  kiloclaw_earlybird_purchases,
  kiloclaw_subscriptions,
  kiloclaw_instances,
  kiloclaw_email_log,
  kiloclaw_cli_runs,
  cloud_agent_webhook_triggers,
  credit_transactions,
  organizations,
} from '@kilocode/db/schema';
import { and, eq, ne, desc, isNull, inArray, sql, like, or } from 'drizzle-orm';
import { deleteWorkerTrigger } from '@/lib/webhook-agent/webhook-agent-client';
import { sentryLogger } from '@/lib/utils.server';
import type { KiloClawDashboardStatus, KiloCodeConfigResponse } from '@/lib/kiloclaw/types';
import { queryDiskUsage } from '@/lib/kiloclaw/disk-usage';
import {
  cycleInboundEmailAddressForInstance,
  getInboundEmailAddressForInstance,
} from '@/lib/kiloclaw/inbound-email-alias';
import {
  getActiveInstance,
  listAllActiveInstances,
  markActiveInstanceDestroyed,
  renameInstance,
  restoreDestroyedInstance,
  workerInstanceId,
  type ActiveKiloClawInstance,
} from '@/lib/kiloclaw/instance-registry';
import {
  getPersonalProvisionLockKey,
  withKiloclawProvisionContextLock,
} from '@/lib/kiloclaw/provision-lock';

import { dayjs } from '@/lib/kilo-pass/dayjs';
import {
  billingHistoryResponseSchema,
  mapStripeInvoiceToBillingHistoryEntry,
} from '@/lib/subscriptions/subscription-center';
import { client as stripe } from '@/lib/stripe-client';
import { APP_URL } from '@/lib/constants';
import { getAffiliateAttribution } from '@/lib/affiliate-attribution';
import { buildAffiliateEventDedupeKey, enqueueAffiliateEventForUser } from '@/lib/affiliate-events';
import { clawAccessProcedure } from '@/lib/kiloclaw/access-gate';
import { cancelCliRun, createCliRun, getCliRunStatus } from '@/lib/kiloclaw/cli-runs';
import { KILOCLAW_EARLYBIRD_EXPIRY_DATE } from '@/lib/kiloclaw/constants';
import {
  getStripePriceIdForClawPlan,
  getStripePriceIdForClawPlanIntro,
} from '@/lib/kiloclaw/stripe-price-ids.server';
import { getStripePriceIdForKiloPass } from '@/lib/kilo-pass/stripe-price-ids.server';
import { KiloPassTier, KiloPassCadence } from '@/lib/kilo-pass/enums';
import { isKiloPassSelectionEligibleForKiloclawCommitUpsell } from '@/lib/kilo-pass/bonus';
import { isStripeSubscriptionEnded } from '@/lib/kilo-pass/stripe-subscription-status';
import { getKiloPassStateForUser } from '@/lib/kilo-pass/state';
import { ensureAutoIntroSchedule, resolvePhasePrice } from '@/lib/kiloclaw/stripe-handlers';
import {
  getKiloClawEarlybirdStateForUser,
  getKiloClawSubscriptionAccessReason,
} from '@/lib/kiloclaw/access-state';
import {
  enrollWithCredits as enrollWithCreditsImpl,
  getEffectiveCreditBalancePreview,
  KILOCLAW_PLAN_COST_MICRODOLLARS,
  KILOCLAW_STANDARD_FIRST_MONTH_MICRODOLLARS,
} from '@/lib/kiloclaw/credit-billing';
import {
  CurrentPersonalSubscriptionResolutionError,
  resolveCurrentPersonalSubscriptionRow,
} from '@/lib/kiloclaw/current-personal-subscription';
import type { ClawBillingStatus } from '@/app/(app)/claw/components/billing/billing-types';
import PostHogClient from '@/lib/posthog';
import { CHANGELOG_ENTRIES } from '@/app/(app)/claw/components/changelog-data';
import { IMPACT_ORDER_ID_MACRO } from '@/lib/impact';

/**
 * Error codes whose messages may contain raw internal details (e.g. filesystem
 * paths) and should NOT be forwarded to the client.
 */
const UNSAFE_ERROR_CODES = new Set(['config_read_failed', 'config_replace_failed']);
const KILOCLAW_USER_SUBSCRIPTION_CHANGE_REASON = {
  cancelRequested: 'user_requested_cancellation',
  reactivated: 'user_reactivated_subscription',
  switchPlanScheduled: 'user_requested_plan_switch',
  switchPlanCanceled: 'user_canceled_plan_switch',
  conversionPrepared: 'user_requested_conversion_prepare',
  conversionPrepareRolledBack: 'user_requested_conversion_prepare_rolled_back',
  conversionRequested: 'user_requested_conversion',
} as const;

async function insertUserSubscriptionChangeLog(
  tx: DrizzleTransaction,
  params: {
    subscriptionId: string;
    userId: string;
    action:
      | 'status_changed'
      | 'canceled'
      | 'reactivated'
      | 'schedule_changed'
      | 'payment_source_changed';
    reason: string;
    before: typeof kiloclaw_subscriptions.$inferSelect;
    after: typeof kiloclaw_subscriptions.$inferSelect;
  }
) {
  await insertKiloClawSubscriptionChangeLog(tx, {
    subscriptionId: params.subscriptionId,
    actor: {
      actorType: 'user',
      actorId: params.userId,
    },
    action: params.action,
    reason: params.reason,
    before: params.before,
    after: params.after,
  });
}

function mapCurrentSubscriptionResolutionError(error: unknown): never {
  if (error instanceof CurrentPersonalSubscriptionResolutionError) {
    sentryLogger('kiloclaw-billing', 'error')('Multiple current personal subscription rows', {
      user_id: error.userId,
      instance_id: error.instanceId,
    });
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'KiloClaw billing state needs support review before continuing.',
    });
  }
  throw error;
}

async function resolveDetachedAccessGrantingPersonalSubscription(params: {
  userId: string;
  executor?: typeof db | DrizzleTransaction;
}) {
  const executor = params.executor ?? db;
  const now = new Date();
  const rows = await executor
    .select()
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, params.userId),
        isNull(kiloclaw_subscriptions.instance_id),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
      )
    );

  const accessGrantingRows = rows.filter(
    row => getKiloClawSubscriptionAccessReason(row, now) !== null
  );
  if (accessGrantingRows.length > 1) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'KiloClaw billing state needs support review before continuing.',
    });
  }

  return accessGrantingRows[0] ?? null;
}

async function getOwnedPersonalInstanceAnchorRow(params: {
  userId: string;
  instanceId: string;
  executor?: typeof db | DrizzleTransaction;
}): Promise<PersonalBillingInstanceRow> {
  const executor = params.executor ?? db;
  const [instance] = await executor
    .select({
      id: kiloclaw_instances.id,
      destroyed_at: kiloclaw_instances.destroyed_at,
    })
    .from(kiloclaw_instances)
    .where(
      and(
        eq(kiloclaw_instances.id, params.instanceId),
        eq(kiloclaw_instances.user_id, params.userId),
        isNull(kiloclaw_instances.organization_id)
      )
    )
    .limit(1);

  if (!instance) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid personal KiloClaw billing anchor.',
    });
  }

  return instance;
}

type PersonalBillingInstanceRow = {
  id: string;
  destroyed_at: string | null;
};

async function getLatestPersonalBillingInstance(
  userId: string,
  executor: typeof db | DrizzleTransaction = db
): Promise<PersonalBillingInstanceRow | null> {
  const [instance] = await executor
    .select({
      id: kiloclaw_instances.id,
      destroyed_at: kiloclaw_instances.destroyed_at,
    })
    .from(kiloclaw_instances)
    .where(and(eq(kiloclaw_instances.user_id, userId), isNull(kiloclaw_instances.organization_id)))
    .orderBy(
      sql`CASE WHEN ${kiloclaw_instances.destroyed_at} IS NULL THEN 0 ELSE 1 END`,
      desc(kiloclaw_instances.created_at)
    )
    .limit(1);

  return instance ?? null;
}

async function resolvePersonalBillingAnchor(params: {
  userId: string;
  instanceId?: string;
  executor?: typeof db | DrizzleTransaction;
}): Promise<{
  activeInstance: ActiveKiloClawInstance | null;
  anchorInstance: PersonalBillingInstanceRow | null;
  currentRow: Awaited<ReturnType<typeof resolveCurrentPersonalSubscriptionRow>>;
}> {
  const executor = params.executor ?? db;
  const activeInstance = await getActiveInstance(params.userId, executor);
  const [anySubscription] = await executor
    .select({ id: kiloclaw_subscriptions.id })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.user_id, params.userId))
    .limit(1);

  let currentRow: Awaited<ReturnType<typeof resolveCurrentPersonalSubscriptionRow>>;
  try {
    currentRow = await resolveCurrentPersonalSubscriptionRow({
      userId: params.userId,
      dbOrTx: executor,
    });
  } catch (error) {
    mapCurrentSubscriptionResolutionError(error);
  }

  const explicitAnchor = params.instanceId
    ? await getOwnedPersonalInstanceAnchorRow({
        userId: params.userId,
        instanceId: params.instanceId,
        executor,
      })
    : null;

  if (activeInstance && !currentRow && anySubscription) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Active KiloClaw instance is missing its current billing row.',
    });
  }

  if (activeInstance && currentRow && currentRow.instance?.id !== activeInstance.id) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'KiloClaw billing anchor does not match active personal instance.',
    });
  }

  if (explicitAnchor && currentRow && currentRow.instance?.id !== explicitAnchor.id) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'KiloClaw billing anchor does not match current billing row.',
    });
  }

  if (explicitAnchor && activeInstance && activeInstance.id !== explicitAnchor.id) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'KiloClaw billing anchor does not match active personal instance.',
    });
  }

  if (explicitAnchor && activeInstance) {
    return {
      activeInstance,
      anchorInstance: explicitAnchor,
      currentRow,
    };
  }

  if (activeInstance && !explicitAnchor) {
    return {
      activeInstance,
      anchorInstance: {
        id: activeInstance.id,
        destroyed_at: null,
      },
      currentRow,
    };
  }

  if (!currentRow) {
    return {
      activeInstance: null,
      anchorInstance: null,
      currentRow: null,
    };
  }

  if (!currentRow.subscription.instance_id || !currentRow.instance) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Current personal KiloClaw billing row is missing its billing anchor.',
    });
  }

  if (explicitAnchor && currentRow.instance.id !== explicitAnchor.id) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'KiloClaw billing anchor does not match current billing row.',
    });
  }

  return {
    activeInstance: null,
    anchorInstance: {
      id: explicitAnchor?.id ?? currentRow.instance.id,
      destroyed_at: explicitAnchor?.destroyed_at ?? currentRow.instance.destroyedAt,
    },
    currentRow,
  };
}

async function getDisplayedPersonalKiloclawSubscription(params: {
  userId: string;
  now?: Date;
}): Promise<{
  currentPersonalInstance: PersonalBillingInstanceRow | null;
  subscription: typeof kiloclaw_subscriptions.$inferSelect | null;
}> {
  void params.now;
  let currentRow: Awaited<ReturnType<typeof resolveCurrentPersonalSubscriptionRow>>;
  try {
    currentRow = await resolveCurrentPersonalSubscriptionRow({
      userId: params.userId,
      dbOrTx: db,
    });
  } catch (error) {
    mapCurrentSubscriptionResolutionError(error);
  }
  const fallbackInstance = currentRow?.instance
    ? {
        id: currentRow.instance.id,
        destroyed_at: currentRow.instance.destroyedAt,
      }
    : await getLatestPersonalBillingInstance(params.userId, db);

  return {
    currentPersonalInstance: fallbackInstance,
    subscription: currentRow?.subscription ?? null,
  };
}

async function hasBlockingPersonalKiloclawSubscriptionAtInstance(params: {
  userId: string;
  instanceId: string;
}): Promise<boolean> {
  const [blockingSubscription] = await db
    .select({ id: kiloclaw_subscriptions.id })
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, params.userId),
        eq(kiloclaw_subscriptions.instance_id, params.instanceId),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id),
        inArray(kiloclaw_subscriptions.status, ['active', 'past_due', 'unpaid'])
      )
    )
    .limit(1);

  return !!blockingSubscription;
}

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

/**
 * True when the user has ever had a paid (non-trial) subscription that is now
 * canceled. Used to gate intro pricing eligibility (spec Credit Enrollment rule 3).
 */
async function hadPriorPaidSubscription(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: kiloclaw_subscriptions.id })
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, userId),
        eq(kiloclaw_subscriptions.status, 'canceled'),
        ne(kiloclaw_subscriptions.plan, 'trial')
      )
    )
    .limit(1);
  return !!row;
}

const kilocodeDefaultModelSchema = z
  .string()
  .regex(
    /^kilocode\/[^/]+\/.+$/,
    'kilocodeDefaultModel must start with kilocode/ and include a provider'
  );

function isValidUserTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

const userTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isValidUserTimezone, 'userTimezone must be a valid IANA timezone');

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
  userTimezone: userTimezoneSchema.nullable().optional(),
});

const updateKiloCodeConfigSchema = z.object({
  kilocodeDefaultModel: kilocodeDefaultModelSchema.nullable().optional(),
});

const patchWebSearchConfigSchema = z.object({
  exaMode: z.enum(['kilo-proxy', 'disabled']).nullable().optional(),
});

const patchChannelsSchema = z.object({
  telegramBotToken: z.string().nullable().optional(),
  discordBotToken: z.string().nullable().optional(),
  slackBotToken: z.string().nullable().optional(),
  slackAppToken: z.string().nullable().optional(),
});

const patchBotIdentitySchema = z.object({
  botName: z.string().trim().min(1).max(80).nullable().optional(),
  botNature: z.string().trim().min(1).max(120).nullable().optional(),
  botVibe: z.string().trim().min(1).max(120).nullable().optional(),
  botEmoji: z.string().trim().min(1).max(16).nullable().optional(),
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

function createNoInstanceStatus(userId: string, workerUrl: string): KiloClawDashboardStatus {
  return {
    userId,
    sandboxId: null,
    provider: null,
    runtimeId: null,
    storageId: null,
    region: null,
    status: null,
    provisionedAt: null,
    lastStartedAt: null,
    lastStoppedAt: null,
    envVarCount: 0,
    secretCount: 0,
    channelCount: 0,
    flyAppName: null,
    flyMachineId: null,
    flyVolumeId: null,
    flyRegion: null,
    machineSize: null,
    openclawVersion: null,
    imageVariant: null,
    trackedImageTag: null,
    trackedImageDigest: null,
    googleConnected: false,
    gmailNotificationsEnabled: false,
    execSecurity: null,
    execAsk: null,
    botName: null,
    botNature: null,
    botVibe: null,
    botEmoji: null,
    workerUrl,
    name: null,
    instanceId: null,
    inboundEmailAddress: null,
    inboundEmailEnabled: false,
  } satisfies KiloClawDashboardStatus;
}

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
  input: z.infer<typeof updateConfigSchema>,
  params: { instanceId: string | null; bootstrapSubscription: boolean },
  executor: typeof db | DrizzleTransaction = db
) {
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

  const pinnedImageTag = params.instanceId
    ? (
        await executor
          .select({ image_tag: kiloclaw_version_pins.image_tag })
          .from(kiloclaw_version_pins)
          .where(eq(kiloclaw_version_pins.instance_id, params.instanceId))
          .limit(1)
      )[0]?.image_tag
    : undefined;

  const client = new KiloClawInternalClient();
  return client.provision(
    user.id,
    {
      envVars: input.envVars,
      encryptedSecrets,
      channels: buildWorkerChannels(input.channels),
      kilocodeApiKey,
      kilocodeApiKeyExpiresAt,
      kilocodeDefaultModel: input.kilocodeDefaultModel ?? undefined,
      userTimezone: input.userTimezone ?? undefined,
      pinnedImageTag,
    },
    params.instanceId
      ? {
          instanceId: params.instanceId,
          bootstrapSubscription: params.bootstrapSubscription,
        }
      : undefined
  );
}

async function enqueueProvisionTrialStartAffiliateEvent(params: {
  userId: string;
  instanceId: string;
}) {
  try {
    const [subscription] = await db
      .select({
        id: kiloclaw_subscriptions.id,
        createdAt: kiloclaw_subscriptions.created_at,
        plan: kiloclaw_subscriptions.plan,
        status: kiloclaw_subscriptions.status,
        trialStartedAt: kiloclaw_subscriptions.trial_started_at,
        accessOrigin: kiloclaw_subscriptions.access_origin,
      })
      .from(kiloclaw_subscriptions)
      .where(
        and(
          eq(kiloclaw_subscriptions.user_id, params.userId),
          eq(kiloclaw_subscriptions.instance_id, params.instanceId)
        )
      )
      .limit(1);

    if (!subscription) return;
    if (subscription.plan !== 'trial' || subscription.status !== 'trialing') return;
    if (subscription.accessOrigin === 'earlybird') return;

    const eventDate = new Date(subscription.trialStartedAt ?? subscription.createdAt);
    await enqueueAffiliateEventForUser({
      userId: params.userId,
      provider: 'impact',
      eventType: 'trial_start',
      dedupeKey: buildAffiliateEventDedupeKey({
        provider: 'impact',
        eventType: 'trial_start',
        entityId: subscription.id,
      }),
      eventDate,
      orderId: IMPACT_ORDER_ID_MACRO,
    });
  } catch (error) {
    sentryLogger('affiliate-events', 'warning')('Affiliate trial start enqueue failed', {
      user_id: params.userId,
      instance_id: params.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function patchConfig(
  user: Parameters<typeof generateApiToken>[0],
  input: z.infer<typeof updateKiloCodeConfigSchema>
): Promise<KiloCodeConfigPublicResponse> {
  const instance = await getActiveInstance(user.id);
  const client = new KiloClawInternalClient();
  const expiresInSeconds = TOKEN_EXPIRY.thirtyDays;
  const kilocodeApiKey = generateApiToken(user, undefined, {
    expiresIn: expiresInSeconds,
  });
  const kilocodeApiKeyExpiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  const response = await client.patchKiloCodeConfig(
    user.id,
    {
      ...input,
      kilocodeApiKey,
      kilocodeApiKeyExpiresAt,
    },
    workerInstanceId(instance)
  );

  return sanitizeKiloCodeConfigResponse(response);
}

const KILOCLAW_STATUS_PAGE_RESOURCE_ID = '8737418';
const STATUS_PAGE_TIMEOUT_MS = 5_000;

const logStatusPageWarning = sentryLogger('kiloclaw-status-page', 'warning');
const logBillingError = sentryLogger('kiloclaw-billing', 'error');
const logDiskUsageError = sentryLogger('kiloclaw-disk-usage', 'error');

async function insertUserSubscriptionChangeLogBestEffort(params: {
  subscriptionId: string;
  userId: string;
  action:
    | 'status_changed'
    | 'canceled'
    | 'reactivated'
    | 'schedule_changed'
    | 'payment_source_changed';
  reason: string;
  before: typeof kiloclaw_subscriptions.$inferSelect;
  after: typeof kiloclaw_subscriptions.$inferSelect;
}) {
  try {
    await insertKiloClawSubscriptionChangeLog(db, {
      subscriptionId: params.subscriptionId,
      actor: {
        actorType: 'user',
        actorId: params.userId,
      },
      action: params.action,
      reason: params.reason,
      before: params.before,
      after: params.after,
    });
  } catch (error) {
    logBillingError('Failed to write user subscription change log', {
      user_id: params.userId,
      subscription_id: params.subscriptionId,
      action: params.action,
      reason: params.reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Returns true if a Stripe error indicates the schedule is already in a terminal state. */
function isScheduleAlreadyInactive(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes('not active') ||
    msg.includes('released') ||
    msg.includes('canceled') ||
    msg.includes('completed')
  );
}

/**
 * Release a Stripe schedule, tolerating already-released/canceled states.
 * Returns true if the schedule was released (or was already inactive).
 * Returns false if the release failed with a transient error.
 */
async function releaseScheduleIfActive(scheduleId: string): Promise<boolean> {
  try {
    await stripe.subscriptionSchedules.release(scheduleId);
    return true;
  } catch (error) {
    return isScheduleAlreadyInactive(error);
  }
}

/** Resolve a Stripe schedule reference (string ID or expanded object) to its ID. */
function resolveScheduleId(schedule: string | { id: string } | null | undefined): string | null {
  if (!schedule) return null;
  return typeof schedule === 'string' ? schedule : schedule.id;
}

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
 * Ensure user has billing access for provisioning.
 * Returns active instance when access is bound to one, otherwise null when
 * caller may provision without existing instance row.
 */
async function ensureProvisionAccess(
  userId: string,
  _userEmail: string,
  executor: typeof db | DrizzleTransaction = db
): Promise<{
  instanceId: string | null;
  bootstrapSubscription: boolean;
  shouldEnqueueTrialStartAffiliate: boolean;
}> {
  const now = new Date();
  const activeInstance = await getActiveInstance(userId, executor);
  const detachedAccessGrantingSubscription =
    await resolveDetachedAccessGrantingPersonalSubscription({
      userId,
      executor,
    });
  const [[anySubscription], [legacyEarlybirdPurchase]] = await Promise.all([
    executor
      .select({ id: kiloclaw_subscriptions.id })
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, userId))
      .limit(1),
    executor
      .select({ id: kiloclaw_earlybird_purchases.id })
      .from(kiloclaw_earlybird_purchases)
      .where(eq(kiloclaw_earlybird_purchases.user_id, userId))
      .limit(1),
  ]);
  let currentRow: Awaited<ReturnType<typeof resolveCurrentPersonalSubscriptionRow>>;
  try {
    currentRow = await resolveCurrentPersonalSubscriptionRow({
      userId,
      dbOrTx: executor,
    });
  } catch (error) {
    mapCurrentSubscriptionResolutionError(error);
  }

  if (legacyEarlybirdPurchase && !currentRow && !detachedAccessGrantingSubscription) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Legacy earlybird access requires manual remediation before reprovisioning.',
    });
  }

  if (activeInstance && !currentRow && !detachedAccessGrantingSubscription && !anySubscription) {
    return {
      instanceId: activeInstance.id,
      bootstrapSubscription: true,
      shouldEnqueueTrialStartAffiliate: true,
    };
  }

  if (activeInstance && !currentRow && !detachedAccessGrantingSubscription) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Active KiloClaw instance is missing its current billing row.',
    });
  }

  if (activeInstance && currentRow && currentRow.instance?.id !== activeInstance.id) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Active KiloClaw instance does not match current billing row.',
    });
  }

  if (getKiloClawSubscriptionAccessReason(currentRow?.subscription, now)) {
    return {
      instanceId: activeInstance?.id ?? null,
      bootstrapSubscription: false,
      shouldEnqueueTrialStartAffiliate: false,
    };
  }

  if (detachedAccessGrantingSubscription) {
    return {
      instanceId: activeInstance?.id ?? null,
      bootstrapSubscription: activeInstance !== null,
      shouldEnqueueTrialStartAffiliate: false,
    };
  }

  if (!anySubscription) {
    return {
      instanceId: activeInstance?.id ?? null,
      bootstrapSubscription: activeInstance !== null,
      shouldEnqueueTrialStartAffiliate: true,
    };
  }

  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'Your trial has expired. Please subscribe to continue using KiloClaw.',
  });
}

// ── Personal subscription management schemas ──────────────────────────

const KiloclawInstanceInputSchema = z.object({ instanceId: z.string().uuid() });
const KiloclawOptionalInstanceInputSchema = z.object({ instanceId: z.string().uuid().optional() });
const KiloclawInstanceSwitchPlanInputSchema = z.object({
  instanceId: z.string().uuid(),
  toPlan: z.enum(['commit', 'standard']),
});

const KiloclawPersonalSubscriptionSchema = z.object({
  instanceId: z.string().uuid(),
  sandboxId: z.string(),
  instanceName: z.string().nullable(),
  destroyedAt: z.string().nullable(),
  plan: z.string(),
  status: z.string(),
  cancelAtPeriodEnd: z.boolean(),
  pendingConversion: z.boolean(),
  scheduledPlan: z.string().nullable(),
  scheduledBy: z.string().nullable(),
  trialStartedAt: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  currentPeriodStart: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  creditRenewalAt: z.string().nullable(),
  commitEndsAt: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  destructionDeadline: z.string().nullable(),
  paymentSource: z.string().nullable(),
  hasStripeFunding: z.boolean(),
  renewalCostMicrodollars: z.number().nullable(),
  showConversionPrompt: z.boolean(),
});
const KiloclawPersonalSubscriptionsOutputSchema = z.object({
  subscriptions: z.array(KiloclawPersonalSubscriptionSchema),
});

const KiloclawBillingHistoryInputSchema = KiloclawInstanceInputSchema.extend({
  cursor: z.string().optional(),
});

const KiloclawCustomerPortalInputSchema = KiloclawInstanceInputSchema.extend({
  returnUrl: z.url().optional(),
});
const KiloclawMutationResultSchema = z.object({ success: z.boolean() });

type KiloclawPersonalSubscriptionRow = {
  subscription: typeof kiloclaw_subscriptions.$inferSelect;
  instance: {
    id: string;
    sandboxId: string;
    name: string | null;
    destroyedAt: string | null;
  };
};

// ── Personal subscription helpers ──────────────────────────────────────

async function getHasActiveKiloPassForUser(userId: string): Promise<boolean> {
  const kiloPassState = await getKiloPassStateForUser(db, userId);
  return !!kiloPassState && !isStripeSubscriptionEnded(kiloPassState.status);
}

function getKiloclawRenewalCostMicrodollars(plan: string): number | null {
  if (plan === 'standard' || plan === 'commit') {
    return KILOCLAW_PLAN_COST_MICRODOLLARS[plan];
  }
  return null;
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = dayjs(value).utc();
  return parsed.isValid() ? parsed.toISOString() : value;
}

async function getPersonalBillingStatus(user: {
  id: string;
  total_microdollars_acquired: number;
  microdollars_used: number;
  kilo_pass_threshold: number | null;
}): Promise<ClawBillingStatus> {
  const now = new Date();
  const { currentPersonalInstance, subscription: sub } =
    await getDisplayedPersonalKiloclawSubscription({
      userId: user.id,
      now,
    });

  const accessReason: 'trial' | 'subscription' | 'earlybird' | null =
    getKiloClawSubscriptionAccessReason(sub, now);
  const hasAccess = accessReason !== null;

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

  const hasPaidSubscription =
    sub &&
    sub.plan !== 'trial' &&
    sub.status !== 'trialing' &&
    (sub.stripe_subscription_id || sub.payment_source === 'credits');

  const hasStripeFunding = hasPaidSubscription ? !!sub.stripe_subscription_id : false;
  const kiloPassState = await getKiloPassStateForUser(db, user.id);
  const hasActiveKiloPass = !!kiloPassState && !isStripeSubscriptionEnded(kiloPassState.status);
  const showConversionPrompt = hasStripeFunding && hasActiveKiloPass;
  const renewalCostMicrodollars =
    hasPaidSubscription && (sub.plan === 'standard' || sub.plan === 'commit')
      ? KILOCLAW_PLAN_COST_MICRODOLLARS[sub.plan]
      : null;

  const subscriptionData = hasPaidSubscription
    ? {
        plan: sub.plan as 'commit' | 'standard',
        status: sub.status as 'active' | 'past_due' | 'canceled' | 'unpaid',
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        currentPeriodEnd: normalizeTimestamp(sub.current_period_end) ?? '',
        commitEndsAt: normalizeTimestamp(sub.commit_ends_at),
        scheduledPlan: sub.scheduled_plan,
        scheduledBy: sub.scheduled_by,
        hasStripeFunding,
        paymentSource: sub.payment_source ?? null,
        creditRenewalAt: normalizeTimestamp(sub.credit_renewal_at),
        renewalCostMicrodollars,
        showConversionPrompt,
        pendingConversion: sub.pending_conversion ?? false,
      }
    : null;

  const isEarlybird = sub?.access_origin === 'earlybird';
  const earlybirdExpiresAt = isEarlybird
    ? (sub.trial_ends_at ?? KILOCLAW_EARLYBIRD_EXPIRY_DATE)
    : null;
  const earlybirdData =
    isEarlybird && earlybirdExpiresAt
      ? {
          purchased: true,
          expiresAt: earlybirdExpiresAt,
          daysRemaining: Math.ceil(
            (new Date(earlybirdExpiresAt).getTime() - Date.now()) / 86_400_000
          ),
        }
      : null;

  let instanceData: ClawBillingStatus['instance'] = null;
  if (currentPersonalInstance) {
    const isDestroyed = currentPersonalInstance.destroyed_at !== null;
    instanceData = {
      id: currentPersonalInstance.id,
      exists: !isDestroyed,
      status: null,
      suspendedAt: sub?.suspended_at ?? null,
      destructionDeadline: sub?.destruction_deadline ?? null,
      destroyed: isDestroyed,
    };
  }

  const [anySubscription, anyPersonalInstanceHistory] = await Promise.all([
    db
      .select({ id: kiloclaw_subscriptions.id })
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1)
      .then(rows => rows[0] ?? null),
    db
      .select({ id: kiloclaw_instances.id })
      .from(kiloclaw_instances)
      .where(
        and(eq(kiloclaw_instances.user_id, user.id), isNull(kiloclaw_instances.organization_id))
      )
      .limit(1)
      .then(rows => rows[0] ?? null),
  ]);

  const creditIntroEligible = !(await hadPriorPaidSubscription(user.id));
  const creditBalanceMicrodollars = user.total_microdollars_acquired - user.microdollars_used;
  const standardCreditCostMicrodollars = creditIntroEligible
    ? KILOCLAW_STANDARD_FIRST_MONTH_MICRODOLLARS
    : KILOCLAW_PLAN_COST_MICRODOLLARS.standard;
  const [standardCreditEnrollmentPreview, commitCreditEnrollmentPreview] = await Promise.all([
    getEffectiveCreditBalancePreview({
      userId: user.id,
      balanceMicrodollars: creditBalanceMicrodollars,
      microdollarsUsed: user.microdollars_used,
      kiloPassThreshold: user.kilo_pass_threshold,
      costMicrodollars: standardCreditCostMicrodollars,
      subscription: kiloPassState,
    }),
    getEffectiveCreditBalancePreview({
      userId: user.id,
      balanceMicrodollars: creditBalanceMicrodollars,
      microdollarsUsed: user.microdollars_used,
      kiloPassThreshold: user.kilo_pass_threshold,
      costMicrodollars: KILOCLAW_PLAN_COST_MICRODOLLARS.commit,
      subscription: kiloPassState,
    }),
  ]);

  return {
    hasAccess,
    accessReason,
    trialEligible: !anyPersonalInstanceHistory && !anySubscription,
    creditBalanceMicrodollars,
    creditIntroEligible,
    hasActiveKiloPass,
    creditEnrollmentPreview: {
      standard: {
        costMicrodollars: standardCreditCostMicrodollars,
        ...standardCreditEnrollmentPreview,
      },
      commit: {
        costMicrodollars: KILOCLAW_PLAN_COST_MICRODOLLARS.commit,
        ...commitCreditEnrollmentPreview,
      },
    },
    trial: trialData,
    subscription: subscriptionData,
    earlybird: earlybirdData,
    instance: instanceData,
  } satisfies ClawBillingStatus;
}

function summarizePersonalBillingStatus(billing: ClawBillingStatus) {
  const hasActiveInstance = billing.instance?.exists ?? false;
  const activeInstanceId = hasActiveInstance ? (billing.instance?.id ?? null) : null;

  return {
    hasActiveInstance,
    activeInstanceHasAccess: hasActiveInstance && billing.hasAccess,
    activeInstanceId,
    creditBalanceMicrodollars: billing.creditBalanceMicrodollars,
    creditIntroEligible: billing.creditIntroEligible,
    hasActiveKiloPass: billing.hasActiveKiloPass,
    creditEnrollmentPreview: billing.creditEnrollmentPreview,
  };
}

function serializeKiloclawPersonalSubscription(
  row: KiloclawPersonalSubscriptionRow,
  hasActiveKiloPass: boolean
) {
  const hasStripeFunding = Boolean(row.subscription.stripe_subscription_id);

  return {
    instanceId: row.instance.id,
    sandboxId: row.instance.sandboxId,
    instanceName: row.instance.name,
    destroyedAt: normalizeTimestamp(row.instance.destroyedAt),
    plan: row.subscription.plan,
    status: row.subscription.status,
    cancelAtPeriodEnd: row.subscription.cancel_at_period_end,
    pendingConversion: row.subscription.pending_conversion,
    scheduledPlan: row.subscription.scheduled_plan ?? null,
    scheduledBy: row.subscription.scheduled_by ?? null,
    trialStartedAt: normalizeTimestamp(row.subscription.trial_started_at),
    trialEndsAt: normalizeTimestamp(row.subscription.trial_ends_at),
    currentPeriodStart: normalizeTimestamp(row.subscription.current_period_start),
    currentPeriodEnd: normalizeTimestamp(row.subscription.current_period_end),
    creditRenewalAt: normalizeTimestamp(row.subscription.credit_renewal_at),
    commitEndsAt: normalizeTimestamp(row.subscription.commit_ends_at),
    suspendedAt: normalizeTimestamp(row.subscription.suspended_at),
    destructionDeadline: normalizeTimestamp(row.subscription.destruction_deadline),
    paymentSource: row.subscription.payment_source ?? null,
    hasStripeFunding,
    renewalCostMicrodollars: getKiloclawRenewalCostMicrodollars(row.subscription.plan),
    showConversionPrompt: hasStripeFunding && hasActiveKiloPass,
  };
}

async function listKiloclawPersonalSubscriptionRows(
  userId: string
): Promise<KiloclawPersonalSubscriptionRow[]> {
  let row: Awaited<ReturnType<typeof resolveCurrentPersonalSubscriptionRow>>;
  try {
    row = await resolveCurrentPersonalSubscriptionRow({ userId, dbOrTx: db });
  } catch (error) {
    mapCurrentSubscriptionResolutionError(error);
  }

  if (!row) {
    return [];
  }

  if (!row.instance) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Current personal KiloClaw billing row is missing its instance.',
    });
  }

  return [
    {
      subscription: row.subscription,
      instance: {
        id: row.instance.id,
        sandboxId: row.instance.sandboxId,
        name: row.instance.name,
        destroyedAt: row.instance.destroyedAt,
      },
    },
  ];
}

async function getKiloclawPersonalSubscriptionRow(params: {
  userId: string;
  instanceId: string;
}): Promise<KiloclawPersonalSubscriptionRow> {
  const [row] = await db
    .select({
      subscription: kiloclaw_subscriptions,
      instance: {
        id: kiloclaw_instances.id,
        sandboxId: kiloclaw_instances.sandbox_id,
        name: kiloclaw_instances.name,
        destroyedAt: kiloclaw_instances.destroyed_at,
      },
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, params.userId),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id),
        eq(kiloclaw_instances.user_id, params.userId),
        eq(kiloclaw_instances.id, params.instanceId),
        isNull(kiloclaw_instances.organization_id)
      )
    )
    .limit(1);

  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Subscription not found.' });
  }

  return row;
}

async function cancelKiloclawSubscriptionForRow(params: {
  subscription: typeof kiloclaw_subscriptions.$inferSelect;
  userId: string;
}) {
  const { subscription, userId } = params;

  if (subscription.status !== 'active') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'No active subscription to cancel.' });
  }

  if (subscription.cancel_at_period_end) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Subscription is already set to cancel.',
    });
  }

  if (subscription.stripe_subscription_id) {
    const liveSub = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
    const scheduleIdToRelease =
      subscription.stripe_schedule_id ?? resolveScheduleId(liveSub.schedule);

    if (scheduleIdToRelease) {
      const released = await releaseScheduleIfActive(scheduleIdToRelease);
      if (!released) {
        logBillingError('Failed to release subscription schedule — aborting cancellation', {
          user_id: userId,
          schedule_id: scheduleIdToRelease,
        });
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Unable to cancel: failed to release pending plan schedule. Please try again.',
        });
      }
    }

    await stripe.subscriptions.update(subscription.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    await db
      .update(kiloclaw_subscriptions)
      .set({
        cancel_at_period_end: true,
        ...(scheduleIdToRelease
          ? { stripe_schedule_id: null, scheduled_plan: null, scheduled_by: null }
          : {}),
      })
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    return;
  }

  if (subscription.payment_source === 'credits') {
    await db
      .update(kiloclaw_subscriptions)
      .set({
        cancel_at_period_end: true,
        stripe_schedule_id: null,
        scheduled_plan: null,
        scheduled_by: null,
      })
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    return;
  }

  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Subscription is in an invalid state: no Stripe subscription and not credit-funded.',
  });
}

async function acceptKiloclawConversionForRow(params: {
  subscription: typeof kiloclaw_subscriptions.$inferSelect;
  userId: string;
}) {
  const { subscription, userId } = params;

  if (subscription.status !== 'active') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'No active subscription to convert.' });
  }

  if (!subscription.stripe_subscription_id) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Subscription is not Stripe-funded — nothing to convert.',
    });
  }

  if (subscription.cancel_at_period_end) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Subscription is already set to cancel.',
    });
  }

  const kiloPassState = await getKiloPassStateForUser(db, userId);
  if (!kiloPassState || isStripeSubscriptionEnded(kiloPassState.status)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Active Kilo Pass required to convert to credit-funded billing.',
    });
  }

  const liveSub = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
  const scheduleIdToRelease =
    subscription.stripe_schedule_id ?? resolveScheduleId(liveSub.schedule);

  if (scheduleIdToRelease) {
    const released = await releaseScheduleIfActive(scheduleIdToRelease);
    if (!released) {
      logBillingError('Failed to release subscription schedule — aborting conversion', {
        user_id: userId,
        schedule_id: scheduleIdToRelease,
      });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Unable to convert: failed to release pending plan schedule. Please try again.',
      });
    }
  }

  await db
    .update(kiloclaw_subscriptions)
    .set({
      pending_conversion: true,
      ...(scheduleIdToRelease
        ? { stripe_schedule_id: null, scheduled_plan: null, scheduled_by: null }
        : {}),
    })
    .where(eq(kiloclaw_subscriptions.id, subscription.id));

  try {
    await stripe.subscriptions.update(subscription.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
  } catch (stripeError) {
    let stripeApplied: boolean | undefined;
    try {
      const refreshed = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
      stripeApplied = refreshed.cancel_at_period_end === true;
    } catch {
      stripeApplied = undefined;
    }

    if (stripeApplied === false) {
      await db
        .update(kiloclaw_subscriptions)
        .set({ pending_conversion: false })
        .where(eq(kiloclaw_subscriptions.id, subscription.id));

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to schedule Stripe cancellation. Please try again.',
        cause: stripeError,
      });
    }

    if (stripeApplied === undefined) {
      logBillingError(
        'acceptConversion: Stripe update threw and re-fetch also failed — state ambiguous, will retry',
        {
          user_id: userId,
          stripe_subscription_id: subscription.stripe_subscription_id,
          error: stripeError instanceof Error ? stripeError.message : String(stripeError),
        }
      );

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Unable to confirm Stripe cancellation. Please try again.',
        cause: stripeError,
      });
    }
  }

  await db
    .update(kiloclaw_subscriptions)
    .set({ cancel_at_period_end: true })
    .where(eq(kiloclaw_subscriptions.id, subscription.id));
}

async function reactivateKiloclawSubscriptionForRow(params: {
  subscription: typeof kiloclaw_subscriptions.$inferSelect;
  userId: string;
}) {
  const { subscription, userId } = params;

  if (subscription.status !== 'active' || !subscription.cancel_at_period_end) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'No pending cancellation to reactivate.',
    });
  }

  if (subscription.stripe_subscription_id) {
    await stripe.subscriptions.update(subscription.stripe_subscription_id, {
      cancel_at_period_end: false,
    });
    await db
      .update(kiloclaw_subscriptions)
      .set({ cancel_at_period_end: false, pending_conversion: false })
      .where(eq(kiloclaw_subscriptions.id, subscription.id));

    try {
      await ensureAutoIntroSchedule(subscription.stripe_subscription_id, userId);
    } catch (error) {
      logBillingError('Failed to restore auto intro schedule after reactivation', {
        user_id: userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (subscription.payment_source === 'credits') {
    await db
      .update(kiloclaw_subscriptions)
      .set({ cancel_at_period_end: false, pending_conversion: false })
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    return;
  }

  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Subscription is in an invalid state: no Stripe subscription and not credit-funded.',
  });
}

async function switchKiloclawPlanForRow(params: {
  subscription: typeof kiloclaw_subscriptions.$inferSelect;
  toPlan: 'commit' | 'standard';
}) {
  const { subscription, toPlan } = params;

  if (subscription.status !== 'active') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'No active subscription to switch.' });
  }

  if (subscription.plan === toPlan) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Already on this plan.' });
  }

  if (subscription.plan !== 'commit' && subscription.plan !== 'standard') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot switch from a trial plan.' });
  }

  if (subscription.stripe_subscription_id) {
    const liveSub = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
    const effectiveScheduleId =
      subscription.stripe_schedule_id ?? resolveScheduleId(liveSub.schedule);

    let effectiveScheduledBy = subscription.scheduled_by;
    if (!subscription.stripe_schedule_id && effectiveScheduleId) {
      const hiddenSchedule = await stripe.subscriptionSchedules.retrieve(effectiveScheduleId);
      if (hiddenSchedule.metadata?.origin === 'auto-intro') {
        effectiveScheduledBy = 'auto';
      } else {
        const released = await releaseScheduleIfActive(effectiveScheduleId);
        if (!released) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message:
              'Unable to switch plan: failed to release existing schedule. Please try again.',
          });
        }
        effectiveScheduledBy = null;
      }
    }

    if (effectiveScheduledBy === 'user') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'A plan switch is already pending. Cancel it before requesting a new one.',
      });
    }

    const targetPriceId = getStripePriceIdForClawPlan(toPlan);

    if (effectiveScheduledBy === 'auto' && effectiveScheduleId) {
      try {
        const existingSchedule = await stripe.subscriptionSchedules.retrieve(effectiveScheduleId);
        const autoCurrentPhase = existingSchedule.phases[0];
        const phase1Price = autoCurrentPhase ? resolvePhasePrice(autoCurrentPhase) : null;

        if (!autoCurrentPhase || !phase1Price) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Cannot determine current phase price from schedule.',
          });
        }

        await stripe.subscriptionSchedules.update(effectiveScheduleId, {
          end_behavior: 'release',
          phases: [
            {
              items: [{ price: phase1Price }],
              start_date: autoCurrentPhase.start_date,
              end_date: autoCurrentPhase.end_date,
            },
            { items: [{ price: targetPriceId }] },
          ],
        });

        await db
          .update(kiloclaw_subscriptions)
          .set({
            stripe_schedule_id: effectiveScheduleId,
            scheduled_plan: toPlan,
            scheduled_by: 'user',
          })
          .where(eq(kiloclaw_subscriptions.id, subscription.id));

        return;
      } catch (error) {
        if (!isScheduleAlreadyInactive(error)) throw error;
        await db
          .update(kiloclaw_subscriptions)
          .set({ stripe_schedule_id: null, scheduled_plan: null, scheduled_by: null })
          .where(eq(kiloclaw_subscriptions.id, subscription.id));
      }
    }

    let stripeScheduleId: string | null = null;
    try {
      const schedule = await stripe.subscriptionSchedules.create({
        from_subscription: subscription.stripe_subscription_id,
      });
      stripeScheduleId = schedule.id;

      const currentPhase = schedule.phases[0];
      if (!currentPhase) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Stripe schedule has no current phase.',
        });
      }

      const freshPhase1Price = resolvePhasePrice(currentPhase);
      if (!freshPhase1Price) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Cannot determine current subscription price from schedule.',
        });
      }

      await stripe.subscriptionSchedules.update(schedule.id, {
        metadata: { origin: 'user-switch' },
        end_behavior: 'release',
        phases: [
          {
            items: [{ price: freshPhase1Price }],
            start_date: currentPhase.start_date,
            end_date: currentPhase.end_date,
          },
          { items: [{ price: targetPriceId }] },
        ],
      });

      const updated = await db
        .update(kiloclaw_subscriptions)
        .set({
          stripe_schedule_id: schedule.id,
          scheduled_plan: toPlan,
          scheduled_by: 'user',
        })
        .where(
          and(
            eq(kiloclaw_subscriptions.id, subscription.id),
            isNull(kiloclaw_subscriptions.stripe_schedule_id)
          )
        )
        .returning({ id: kiloclaw_subscriptions.id });

      if (updated.length === 0) {
        await stripe.subscriptionSchedules.release(schedule.id);
        stripeScheduleId = null;
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A plan switch is already pending. Cancel it before requesting a new one.',
        });
      }

      return;
    } catch (error) {
      if (stripeScheduleId) {
        try {
          await stripe.subscriptionSchedules.release(stripeScheduleId);
        } catch {
          // Ignore best-effort cleanup errors.
        }
      }
      throw error;
    }
  }

  if (subscription.payment_source === 'credits') {
    if (subscription.scheduled_plan && subscription.scheduled_by === 'user') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'A plan switch is already pending. Cancel it before requesting a new one.',
      });
    }

    await db
      .update(kiloclaw_subscriptions)
      .set({ scheduled_plan: toPlan, scheduled_by: 'user' })
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    return;
  }

  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Subscription is in an invalid state: no Stripe subscription and not credit-funded.',
  });
}

async function cancelKiloclawPlanSwitchForRow(params: {
  subscription: typeof kiloclaw_subscriptions.$inferSelect;
  userId: string;
}) {
  const { subscription, userId } = params;

  if (!subscription.scheduled_plan) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'No pending plan switch to cancel.' });
  }

  if (subscription.scheduled_by !== 'user') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'No user-initiated plan switch to cancel.',
    });
  }

  if (subscription.stripe_schedule_id) {
    const released = await releaseScheduleIfActive(subscription.stripe_schedule_id);
    if (!released) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to release pending plan schedule. Please try again.',
      });
    }

    await db
      .update(kiloclaw_subscriptions)
      .set({ stripe_schedule_id: null, scheduled_plan: null, scheduled_by: null })
      .where(eq(kiloclaw_subscriptions.id, subscription.id));

    try {
      if (subscription.stripe_subscription_id) {
        await ensureAutoIntroSchedule(subscription.stripe_subscription_id, userId);
      }
    } catch (error) {
      logBillingError('Failed to restore auto intro schedule after cancel plan switch', {
        user_id: userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  await db
    .update(kiloclaw_subscriptions)
    .set({ scheduled_plan: null, scheduled_by: null })
    .where(eq(kiloclaw_subscriptions.id, subscription.id));
}

export const kiloclawRouter = createTRPCRouter({
  getChangelog: baseProcedure.query(() => {
    return CHANGELOG_ENTRIES;
  }),

  serviceDegraded: baseProcedure.query(async () => {
    return fetchKiloClawServiceDegraded();
  }),

  latestVersion: baseProcedure.query(async () => {
    const client = new KiloClawInternalClient();
    return client.getLatestVersion();
  }),

  /**
   * List all active KiloClaw instances for the user across all contexts
   * (personal + every org they belong to). Returns lightweight metadata
   * with live status for each instance.
   */
  listAllInstances: baseProcedure.query(async ({ ctx }) => {
    const instances = await listAllActiveInstances(ctx.user.id);
    if (instances.length === 0) return [];

    // Build org name map for instances that belong to organizations
    const orgIds = [
      ...new Set(instances.map(i => i.organizationId).filter((id): id is string => id !== null)),
    ];
    const orgNameMap = new Map<string, string>();
    if (orgIds.length > 0) {
      const orgs = await db
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(inArray(organizations.id, orgIds));
      for (const org of orgs) {
        orgNameMap.set(org.id, org.name);
      }
    }

    // Fetch live status from each instance's worker in parallel
    const client = new KiloClawInternalClient();
    const results = await Promise.all(
      instances.map(async instance => {
        let status: string | null = null;
        try {
          const workerStatus = await client.getStatus(ctx.user.id, workerInstanceId(instance));
          status = workerStatus.status;
        } catch {
          // Worker unreachable — show as null (unknown)
        }
        return {
          id: instance.id,
          sandboxId: instance.sandboxId,
          name: instance.name,
          organizationId: instance.organizationId,
          organizationName: instance.organizationId
            ? (orgNameMap.get(instance.organizationId) ?? null)
            : null,
          status,
        };
      })
    );

    return results;
  }),

  getStatus: baseProcedure.query(async ({ ctx }) => {
    const instance = await getActiveInstance(ctx.user.id);
    const workerUrl = KILOCLAW_API_URL || 'https://claw.kilo.ai';

    if (!instance) {
      return createNoInstanceStatus(ctx.user.id, workerUrl);
    }

    const client = new KiloClawInternalClient();
    const [status, inboundEmailAddress] = await Promise.all([
      client.getStatus(ctx.user.id, workerInstanceId(instance)),
      getInboundEmailAddressForInstance(instance.id),
    ]);

    return {
      ...status,
      name: instance.name ?? null,
      workerUrl,
      // Only expose instanceId for instance-keyed instances (ki_ sandboxId).
      // Legacy instances use userId-keyed DOs — returning their row UUID would
      // cause the frontend/gateway to resolve the wrong DO.
      instanceId: workerInstanceId(instance) ? instance.id : null,
      inboundEmailAddress,
      inboundEmailEnabled: instance.inboundEmailEnabled,
    } satisfies KiloClawDashboardStatus;
  }),

  getDiskUsage: baseProcedure.query(async ({ ctx }) => {
    const instance = await getActiveInstance(ctx.user.id);
    if (!instance) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No active instance' });
    }
    try {
      return await queryDiskUsage(instance.sandboxId);
    } catch (error) {
      logDiskUsageError('Failed to fetch disk usage', { error, sandboxId: instance.sandboxId });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch disk usage',
        cause: error,
      });
    }
  }),

  renameInstance: baseProcedure
    .input(z.object({ name: z.string().min(1).max(50).nullable() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await renameInstance(ctx.user.id, input.name);
      } catch (error) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: error instanceof Error ? error.message : 'Failed to rename instance',
        });
      }
    }),

  cycleInboundEmailAddress: baseProcedure.mutation(async ({ ctx }) => {
    const instance = await getActiveInstance(ctx.user.id);
    if (!instance) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No active instance' });
    }
    return {
      inboundEmailAddress: await cycleInboundEmailAddressForInstance(instance.id),
    };
  }),

  getActiveInstanceId: clawAccessProcedure.query(async ({ ctx }) => {
    const instance = await getActiveInstance(ctx.user.id);
    return instance ? { instanceId: instance.id } : null;
  }),

  getStreamChatCredentials: clawAccessProcedure.query(async ({ ctx }) => {
    const instance = await getActiveInstance(ctx.user.id);
    const client = new KiloClawInternalClient();
    return client.getStreamChatCredentials(ctx.user.id, workerInstanceId(instance));
  }),

  sendChatMessage: clawAccessProcedure
    .input(
      z.object({
        instanceId: z.string().uuid().optional(),
        message: z.string().min(1).max(32_000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.instanceId) {
        // Explicit instanceId: verify ownership and non-destroyed
        const [row] = await db
          .select({ id: kiloclaw_instances.id })
          .from(kiloclaw_instances)
          .where(
            and(
              eq(kiloclaw_instances.id, input.instanceId),
              eq(kiloclaw_instances.user_id, ctx.user.id),
              isNull(kiloclaw_instances.destroyed_at)
            )
          )
          .limit(1);
        if (!row) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'No active KiloClaw instance found',
          });
        }
      } else {
        // No instanceId: verify the user has any active instance
        const instance = await getActiveInstance(ctx.user.id);
        if (!instance) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'No active KiloClaw instance found',
          });
        }
      }

      const client = new KiloClawInternalClient();
      try {
        return await client.sendChatMessage(ctx.user.id, input.message, input.instanceId);
      } catch (err) {
        if (err instanceof KiloClawApiError) {
          const { message } = getKiloClawApiErrorPayload(err);
          const code =
            err.statusCode === 400
              ? 'BAD_REQUEST'
              : err.statusCode === 403
                ? 'FORBIDDEN'
                : err.statusCode === 404
                  ? 'NOT_FOUND'
                  : err.statusCode === 503
                    ? 'PRECONDITION_FAILED'
                    : 'INTERNAL_SERVER_ERROR';
          throw new TRPCError({
            code,
            message: message ?? 'Failed to send chat message',
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to send chat message',
        });
      }
    }),

  // Instance lifecycle
  start: clawAccessProcedure.mutation(async ({ ctx }) => {
    const instance = await getActiveInstance(ctx.user.id);
    const client = new KiloClawInternalClient();
    const result = await client.start(ctx.user.id, workerInstanceId(instance));
    // /api/platform/start always returns { ok: true } regardless of whether
    // the machine transitioned state, so this may fire for no-op requests.
    // The UI only enables Start when isStartable is true, so false fires are rare.
    PostHogClient().capture({
      distinctId: ctx.user.google_user_email,
      event: 'claw_instance_started',
      properties: { user_id: ctx.user.id },
    });
    return result;
  }),

  stop: clawAccessProcedure.mutation(async ({ ctx }) => {
    const instance = await getActiveInstance(ctx.user.id);
    const client = new KiloClawInternalClient();
    return client.stop(ctx.user.id, workerInstanceId(instance));
  }),

  destroy: baseProcedure.mutation(async ({ ctx }) => {
    const destroyedRow = await markActiveInstanceDestroyed(ctx.user.id);
    const client = new KiloClawInternalClient();
    let result: Awaited<ReturnType<KiloClawInternalClient['destroy']>>;
    try {
      result = await client.destroy(ctx.user.id, workerInstanceId(destroyedRow));
    } catch (error) {
      if (destroyedRow) {
        await restoreDestroyedInstance(destroyedRow.id);
      }
      throw error;
    }

    // Post-destroy cleanup: best-effort DB tidying that must not undo a
    // successful destroy. If any of these fail, log and move on.
    try {
      // Clear the destruction lifecycle so the billing cron doesn't
      // send warning emails or attempt a redundant destroy.
      // Current billing row stays anchored to destroyed instance until
      // reprovision bootstrap creates successor row on next provision.
      // Only clear suspended_at for non-past_due subscriptions — nulling it
      // on a past_due row would re-enable access without fixing payment.
      if (destroyedRow) {
        const [sub] = await db
          .select({ status: kiloclaw_subscriptions.status })
          .from(kiloclaw_subscriptions)
          .where(
            and(
              eq(kiloclaw_subscriptions.user_id, ctx.user.id),
              eq(kiloclaw_subscriptions.instance_id, destroyedRow.id)
            )
          )
          .limit(1);
        const clearFields: { destruction_deadline: null; suspended_at?: null } = {
          destruction_deadline: null,
        };
        if (sub && sub.status !== 'past_due') {
          clearFields.suspended_at = null;
        }
        await db
          .update(kiloclaw_subscriptions)
          .set(clearFields)
          .where(
            and(
              eq(kiloclaw_subscriptions.user_id, ctx.user.id),
              eq(kiloclaw_subscriptions.instance_id, destroyedRow.id)
            )
          );
      }

      // Clear lifecycle emails so they can fire again if the user re-provisions.
      const resettableEmailTypes = [
        'claw_suspended_trial',
        'claw_suspended_subscription',
        'claw_suspended_payment',
        'claw_destruction_warning',
        'claw_instance_destroyed',
      ];
      await db
        .delete(kiloclaw_email_log)
        .where(
          and(
            eq(kiloclaw_email_log.user_id, ctx.user.id),
            inArray(kiloclaw_email_log.email_type, resettableEmailTypes)
          )
        );
      // Clear per-instance ready emails so a future re-provision triggers the notification.
      await db
        .delete(kiloclaw_email_log)
        .where(
          and(
            eq(kiloclaw_email_log.user_id, ctx.user.id),
            or(
              destroyedRow
                ? and(
                    eq(kiloclaw_email_log.instance_id, destroyedRow.id),
                    eq(kiloclaw_email_log.email_type, 'claw_instance_ready')
                  )
                : undefined,
              destroyedRow
                ? and(
                    isNull(kiloclaw_email_log.instance_id),
                    eq(
                      kiloclaw_email_log.email_type,
                      `claw_instance_ready:${destroyedRow.sandboxId}`
                    )
                  )
                : undefined
            )
          )
        );

      // Clean up webhook/scheduled triggers for the destroyed instance.
      // Delete from worker DOs first (best-effort), then from PostgreSQL.
      if (destroyedRow) {
        const orphanedTriggers = await db
          .select({
            triggerId: cloud_agent_webhook_triggers.trigger_id,
            userId: cloud_agent_webhook_triggers.user_id,
            organizationId: cloud_agent_webhook_triggers.organization_id,
          })
          .from(cloud_agent_webhook_triggers)
          .where(eq(cloud_agent_webhook_triggers.kiloclaw_instance_id, destroyedRow.id));

        for (const t of orphanedTriggers) {
          await deleteWorkerTrigger(
            t.userId ?? undefined,
            t.organizationId ?? undefined,
            t.triggerId
          ).catch(err => {
            console.warn(
              '[kiloclaw] Failed to delete worker trigger on destroy:',
              t.triggerId,
              err
            );
          });
        }

        if (orphanedTriggers.length > 0) {
          await db
            .delete(cloud_agent_webhook_triggers)
            .where(eq(cloud_agent_webhook_triggers.kiloclaw_instance_id, destroyedRow.id));
        }
      }
    } catch (cleanupError) {
      console.error('[kiloclaw] Post-destroy cleanup failed:', cleanupError);
    }

    return result;
  }),

  // Explicit lifecycle APIs
  provision: baseProcedure.input(updateConfigSchema).mutation(async ({ ctx, input }) => {
    return await withKiloclawProvisionContextLock(
      getPersonalProvisionLockKey(ctx.user.id),
      async () => {
        const { instanceId, bootstrapSubscription, shouldEnqueueTrialStartAffiliate } =
          await ensureProvisionAccess(ctx.user.id, ctx.user.google_user_email);
        const result = await provisionInstance(ctx.user, input, {
          instanceId,
          bootstrapSubscription,
        });
        if (shouldEnqueueTrialStartAffiliate) {
          await enqueueProvisionTrialStartAffiliateEvent({
            userId: ctx.user.id,
            instanceId: result.instanceId,
          });
        }
        return result;
      }
    );
  }),

  patchConfig: clawAccessProcedure
    .input(updateKiloCodeConfigSchema)
    .mutation(async ({ ctx, input }) => {
      return patchConfig(ctx.user, input);
    }),

  // Backward-compatible alias — uses the same trial-bootstrap flow as provision
  // so first-time callers can create a trial row (clawAccessProcedure would reject them).
  updateConfig: baseProcedure.input(updateConfigSchema).mutation(async ({ ctx, input }) => {
    return await withKiloclawProvisionContextLock(
      getPersonalProvisionLockKey(ctx.user.id),
      async () => {
        const { instanceId, bootstrapSubscription, shouldEnqueueTrialStartAffiliate } =
          await ensureProvisionAccess(ctx.user.id, ctx.user.google_user_email);
        const result = await provisionInstance(ctx.user, input, {
          instanceId,
          bootstrapSubscription,
        });
        if (shouldEnqueueTrialStartAffiliate) {
          await enqueueProvisionTrialStartAffiliateEvent({
            userId: ctx.user.id,
            instanceId: result.instanceId,
          });
        }
        return result;
      }
    );
  }),

  updateKiloCodeConfig: clawAccessProcedure
    .input(updateKiloCodeConfigSchema)
    .mutation(async ({ ctx, input }) => {
      return patchConfig(ctx.user, input);
    }),

  patchChannels: clawAccessProcedure.input(patchChannelsSchema).mutation(async ({ ctx, input }) => {
    const instance = await getActiveInstance(ctx.user.id);
    const client = new KiloClawInternalClient();
    return client.patchChannels(
      ctx.user.id,
      { channels: buildWorkerChannelsPatch(input) },
      workerInstanceId(instance)
    );
  }),

  patchExecPreset: clawAccessProcedure
    .input(z.object({ security: z.string().optional(), ask: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const instance = await getActiveInstance(ctx.user.id);
      const client = new KiloClawInternalClient();
      return client.patchExecPreset(ctx.user.id, input, workerInstanceId(instance));
    }),

  patchWebSearchConfig: clawAccessProcedure
    .input(patchWebSearchConfigSchema)
    .mutation(async ({ ctx, input }) => {
      const instance = await getActiveInstance(ctx.user.id);
      const client = new KiloClawInternalClient();
      return client.patchWebSearchConfig(ctx.user.id, input, workerInstanceId(instance));
    }),

  patchBotIdentity: clawAccessProcedure
    .input(patchBotIdentitySchema)
    .mutation(async ({ ctx, input }) => {
      const instance = await getActiveInstance(ctx.user.id);
      const client = new KiloClawInternalClient();
      return client.patchBotIdentity(ctx.user.id, input, workerInstanceId(instance));
    }),

  /**
   * Generic secret patch — supports both catalog secrets and custom user secrets.
   *
   * Catalog keys (in ALL_SECRET_FIELD_KEYS) are validated against catalog patterns.
   * Custom keys (valid env var names not in catalog) skip pattern validation but
   * enforce a generous max value length. All values are RSA-encrypted before
   * forwarding to the worker.
   */
  patchSecrets: clawAccessProcedure
    .input(
      z.object({
        secrets: z
          .record(z.string(), z.string().max(MAX_CUSTOM_SECRET_VALUE_LENGTH).nullable())
          .refine(
            obj =>
              Object.keys(obj).every(
                k => ALL_SECRET_FIELD_KEYS.has(k) || isValidCustomSecretKey(k)
              ),
            {
              message:
                'Invalid secret key: must be a catalog field key or valid env var name (A-Z, 0-9, _, no KILOCLAW_ prefix)',
            }
          ),
        meta: z
          .record(
            z.string(),
            z.object({
              configPath: z
                .string()
                .refine(isValidConfigPath, {
                  message:
                    'Not a supported credential path. See https://docs.openclaw.ai/reference/secretref-credential-surface',
                })
                .optional(),
            })
          )
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const secrets = input.secrets;

      // 1. allFieldsRequired is enforced by the DO on post-merge state (not here),
      //    so single-field rotations work when the other field is already stored.

      // 2. Validate non-null values: catalog keys get pattern + maxLength checks,
      //    custom keys only get the blanket max from the zod schema above.
      for (const [key, value] of Object.entries(secrets)) {
        if (value === null) continue;

        if (ALL_SECRET_FIELD_KEYS.has(key)) {
          // Catalog key — validate against catalog patterns and per-field maxLength
          const entry = FIELD_KEY_TO_ENTRY.get(key);
          const field = entry?.fields.find(f => f.key === key);

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
        // Custom keys: no pattern validation — the blanket zod .max() is sufficient
      }

      // 3. Encrypt non-null values
      const encryptedPatch: Record<string, ReturnType<typeof encryptKiloClawSecret> | null> = {};
      for (const [key, value] of Object.entries(secrets)) {
        encryptedPatch[key] = value === null ? null : encryptKiloClawSecret(value);
      }

      // 4. Forward to worker — translate 4xx responses into TRPCErrors
      const instance = await getActiveInstance(ctx.user.id);
      const client = new KiloClawInternalClient();
      try {
        return await client.patchSecrets(
          ctx.user.id,
          { secrets: encryptedPatch, meta: input.meta },
          workerInstanceId(instance)
        );
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
    const instance = await getActiveInstance(ctx.user.id);
    const client = new KiloClawUserClient(
      generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes })
    );
    return client.getConfig({ userId: ctx.user.id, instanceId: workerInstanceId(instance) });
  }),

  getChannelCatalog: baseProcedure.query(async ({ ctx }) => {
    const instance = await getActiveInstance(ctx.user.id);
    const client = new KiloClawUserClient(
      generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes })
    );
    const config = await client.getConfig({
      userId: ctx.user.id,
      instanceId: workerInstanceId(instance),
    });
    const channels = getEntriesByCategory('channel');

    return channels.map(entry => ({
      id: entry.id,
      label: entry.label,
      configured: config.configuredSecrets[entry.id] ?? false,
      fields: entry.fields.map(f => ({
        key: f.key,
        label: f.label,
        placeholder: f.placeholder,
        placeholderConfigured: f.placeholderConfigured,
        validationPattern: f.validationPattern,
        validationMessage: f.validationMessage,
      })),
      helpText: entry.helpText,
      helpUrl: entry.helpUrl,
      guideText: entry.guideText,
      guideUrl: entry.guideUrl,
      allFieldsRequired: entry.allFieldsRequired ?? false,
    }));
  }),

  getSecretCatalog: baseProcedure.query(async ({ ctx }) => {
    const instance = await getActiveInstance(ctx.user.id);
    const client = new KiloClawUserClient(
      generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes })
    );
    const config = await client.getConfig({
      userId: ctx.user.id,
      instanceId: workerInstanceId(instance),
    });
    const tools = getEntriesByCategory('tool');

    return tools.map(entry => ({
      id: entry.id,
      label: entry.label,
      configured: config.configuredSecrets[entry.id] ?? false,
      fields: entry.fields.map(f => ({
        key: f.key,
        label: f.label,
        placeholder: f.placeholder,
        placeholderConfigured: f.placeholderConfigured,
        validationPattern: f.validationPattern,
        validationMessage: f.validationMessage,
      })),
      helpText: entry.helpText,
      helpUrl: entry.helpUrl,
      guideText: entry.guideText,
      guideUrl: entry.guideUrl,
      allFieldsRequired: entry.allFieldsRequired ?? false,
    }));
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
      const instance = await getActiveInstance(ctx.user.id);
      const client = new KiloClawUserClient(
        generateApiToken(ctx.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes })
      );
      const result = await client.restartMachine(
        input?.imageTag ? { imageTag: input.imageTag } : undefined,
        { userId: ctx.user.id, instanceId: workerInstanceId(instance) }
      );
      if (result.success) {
        PostHogClient().capture({
          distinctId: ctx.user.google_user_email,
          event: 'claw_instance_redeployed',
          properties: {
            user_id: ctx.user.id,
            redeploy_mode: input?.imageTag === 'latest' ? 'upgrade' : 'redeploy',
          },
        });
      }
      return result;
    }),

  listPairingRequests: clawAccessProcedure
    .input(z.object({ refresh: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const instance = await getActiveInstance(ctx.user.id);
      const client = new KiloClawInternalClient();
      return client.listPairingRequests(ctx.user.id, input?.refresh, workerInstanceId(instance));
    }),

  approvePairingRequest: clawAccessProcedure
    .input(z.object({ channel: z.string().min(1), code: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const instance = await getActiveInstance(ctx.user.id);
      const client = new KiloClawInternalClient();
      return client.approvePairingRequest(
        ctx.user.id,
        input.channel,
        input.code,
        workerInstanceId(instance)
      );
    }),

  listDevicePairingRequests: clawAccessProcedure
    .input(z.object({ refresh: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const instance = await getActiveInstance(ctx.user.id);
      const client = new KiloClawInternalClient();
      return client.listDevicePairingRequests(
        ctx.user.id,
        input?.refresh,
        workerInstanceId(instance)
      );
    }),

  approveDevicePairingRequest: clawAccessProcedure
    .input(z.object({ requestId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const instance = await getActiveInstance(ctx.user.id);
      const client = new KiloClawInternalClient();
      return client.approveDevicePairingRequest(
        ctx.user.id,
        input.requestId,
        workerInstanceId(instance)
      );
    }),

  gatewayStatus: baseProcedure.query(async ({ ctx }) => {
    try {
      const instance = await getActiveInstance(ctx.user.id);
      const client = new KiloClawInternalClient();
      return await client.getGatewayStatus(ctx.user.id, workerInstanceId(instance));
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

  gatewayReady: baseProcedure.query(async ({ ctx }) => {
    try {
      const instance = await getActiveInstance(ctx.user.id);
      const client = new KiloClawInternalClient();
      return await client.getGatewayReady(ctx.user.id, workerInstanceId(instance));
    } catch (err) {
      console.error('[gatewayReady] error for user:', ctx.user.id, err);
      if (err instanceof KiloClawApiError && (err.statusCode === 404 || err.statusCode === 409)) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Gateway ready check unavailable',
        });
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch gateway ready state',
      });
    }
  }),

  controllerVersion: baseProcedure.query(async ({ ctx }) => {
    const instance = await getActiveInstance(ctx.user.id);
    const client = new KiloClawInternalClient();
    return client.getControllerVersion(ctx.user.id, workerInstanceId(instance));
  }),

  restartOpenClaw: clawAccessProcedure.mutation(async ({ ctx }) => {
    const instance = await getActiveInstance(ctx.user.id);
    const client = new KiloClawInternalClient();
    return client.restartGatewayProcess(ctx.user.id, workerInstanceId(instance));
  }),

  runDoctor: clawAccessProcedure.mutation(async ({ ctx }) => {
    const instance = await getActiveInstance(ctx.user.id);
    const client = new KiloClawInternalClient();
    return client.runDoctor(ctx.user.id, workerInstanceId(instance));
  }),

  // ── Kilo CLI Run ──────────────────────────────────────────────────

  startKiloCliRun: clawAccessProcedure
    .input(z.object({ prompt: z.string().min(1).max(10_000) }))
    .mutation(async ({ ctx, input }) => {
      const instance = await getActiveInstance(ctx.user.id);
      const client = new KiloClawInternalClient();

      let result: Awaited<ReturnType<KiloClawInternalClient['startKiloCliRun']>>;
      try {
        result = await client.startKiloCliRun(
          ctx.user.id,
          input.prompt,
          workerInstanceId(instance)
        );
      } catch (err) {
        if (err instanceof KiloClawApiError) {
          const { code, message } = getKiloClawApiErrorPayload(err);
          if (code === 'controller_route_unavailable') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Instance needs redeploy to support recovery',
              cause: new UpstreamApiError('controller_route_unavailable'),
            });
          }
          if (err.statusCode === 409) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: message ?? 'Instance is busy',
              cause: code ? new UpstreamApiError(code) : undefined,
            });
          }
        }
        throw err;
      }

      const runId = await createCliRun({
        userId: ctx.user.id,
        instanceId: instance?.id ?? null,
        prompt: input.prompt,
        startedAt: result.startedAt,
        initiatedByAdminId: null,
      });

      return { ...result, id: runId };
    }),

  getKiloCliRunStatus: clawAccessProcedure
    .input(z.object({ runId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const instance = await getActiveInstance(ctx.user.id);
      return getCliRunStatus({
        runId: input.runId,
        userId: ctx.user.id,
        instanceId: instance?.id ?? null,
        workerInstanceId: workerInstanceId(instance),
      });
    }),

  cancelKiloCliRun: clawAccessProcedure
    .input(z.object({ runId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const instance = await getActiveInstance(ctx.user.id);
      const result = await cancelCliRun({
        runId: input.runId,
        userId: ctx.user.id,
        instanceId: instance?.id ?? null,
        workerInstanceId: workerInstanceId(instance),
      });

      if (!result.runFound) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Kilo CLI run not found',
        });
      }

      return { ok: result.ok };
    }),

  listKiloCliRuns: clawAccessProcedure
    .input(z.object({ limit: z.number().min(1).max(50).default(10) }).optional())
    .query(async ({ ctx, input }) => {
      const instance = await getActiveInstance(ctx.user.id);
      const limit = input?.limit ?? 10;
      const instanceFilter = instance ? eq(kiloclaw_cli_runs.instance_id, instance.id) : undefined;
      const runs = await db
        .select()
        .from(kiloclaw_cli_runs)
        .where(and(eq(kiloclaw_cli_runs.user_id, ctx.user.id), instanceFilter))
        .orderBy(desc(kiloclaw_cli_runs.started_at))
        .limit(limit);

      return { runs };
    }),

  restoreConfig: clawAccessProcedure.mutation(async ({ ctx }) => {
    const instance = await getActiveInstance(ctx.user.id);
    const client = new KiloClawInternalClient();
    return client.restoreConfig(ctx.user.id, undefined, workerInstanceId(instance));
  }),

  getGoogleSetupCommand: clawAccessProcedure.query(async ({ ctx }) => {
    // Short-lived token — the user should run the setup command promptly.
    // Regenerated on each page load, so 1 hour is sufficient.
    const token = generateApiToken(ctx.user, undefined, {
      expiresIn: TOKEN_EXPIRY.oneHour,
    });
    const isDev = process.env.NODE_ENV === 'development';
    const imageTag = isDev ? ':dev' : ':latest';
    const workerFlag = isDev
      ? ` --worker-url=${process.env.KILOCLAW_API_URL ?? 'http://localhost:8795'}`
      : '';
    const gmailPushFlag = isDev ? ' --gmail-push-worker-url=${GMAIL_PUSH_WORKER_URL}' : '';
    const instance = await getActiveInstance(ctx.user.id);
    const iid = workerInstanceId(instance);
    const instanceFlag = iid ? ` --instance-id=${iid}` : '';
    const imageUrl = `ghcr.io/kilo-org/google-setup${imageTag}`;
    return {
      command: `docker pull ${imageUrl} ; docker run -it --network host ${imageUrl} --token="${token}"${instanceFlag}${workerFlag}${gmailPushFlag}`,
    };
  }),

  disconnectGoogle: clawAccessProcedure.mutation(async ({ ctx }) => {
    const instance = await getActiveInstance(ctx.user.id);
    const client = new KiloClawInternalClient();
    return client.clearGoogleCredentials(ctx.user.id, workerInstanceId(instance));
  }),

  setGmailNotifications: baseProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const instance = await getActiveInstance(ctx.user.id);
      const client = new KiloClawInternalClient();
      try {
        if (input.enabled) {
          return await client.enableGmailNotifications(ctx.user.id, workerInstanceId(instance));
        }
        return await client.disableGmailNotifications(ctx.user.id, workerInstanceId(instance));
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
      const state = await getKiloClawEarlybirdStateForUser(ctx.user.id);
      return { purchased: state.purchased };
    }),

  createEarlybirdCheckoutSession: baseProcedure
    .output(z.object({ url: z.url().nullable() }))
    .mutation(async () => {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Earlybird offer is no longer available.',
      });
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
    const instance = await getActiveInstance(ctx.user.id);
    if (!instance) return null;

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
      .where(eq(kiloclaw_version_pins.instance_id, instance.id))
      .limit(1);

    if (!result) return null;

    return {
      ...result.pin,
      pinnedBySelf: result.pin.pinned_by === ctx.user.id,
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
      const instance = await getActiveInstance(ctx.user.id);
      if (!instance) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No active KiloClaw instance found' });
      }

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
        .where(eq(kiloclaw_version_pins.instance_id, instance.id))
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
            instance_id: instance.id,
            image_tag: input.imageTag,
            pinned_by: ctx.user.id,
            reason: input.reason ?? null,
          })
          .onConflictDoUpdate({
            target: kiloclaw_version_pins.instance_id,
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
    const instance = await getActiveInstance(ctx.user.id);
    if (!instance) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No active KiloClaw instance found' });
    }

    // Atomically delete only self-set pins — the WHERE clause enforces the admin-pin guard
    // so there's no TOCTOU race between checking pinned_by and deleting.
    const [deleted] = await db
      .delete(kiloclaw_version_pins)
      .where(
        and(
          eq(kiloclaw_version_pins.instance_id, instance.id),
          eq(kiloclaw_version_pins.pinned_by, ctx.user.id)
        )
      )
      .returning();

    if (!deleted) {
      // Check if a pin exists at all — if so, it's admin-set
      const [existingPin] = await db
        .select({ pinned_by: kiloclaw_version_pins.pinned_by })
        .from(kiloclaw_version_pins)
        .where(eq(kiloclaw_version_pins.instance_id, instance.id))
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
      const instance = await getActiveInstance(ctx.user.id);
      const client = new KiloClawInternalClient();
      const result = await client.getFileTree(ctx.user.id, workerInstanceId(instance));
      return result.tree;
    } catch (err) {
      handleFileOperationError(err, 'fetch file tree');
    }
  }),

  readFile: clawAccessProcedure
    .input(z.object({ path: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        const instance = await getActiveInstance(ctx.user.id);
        const client = new KiloClawInternalClient();
        return await client.readFile(ctx.user.id, input.path, workerInstanceId(instance));
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
        const instance = await getActiveInstance(ctx.user.id);
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

        return await client.writeFile(
          ctx.user.id,
          input.path,
          content,
          input.etag,
          workerInstanceId(instance)
        );
      } catch (err) {
        handleFileOperationError(err, 'write file');
      }
    }),

  patchOpenclawConfig: clawAccessProcedure
    .input(z.object({ patch: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const instance = await getActiveInstance(ctx.user.id);
        const client = new KiloClawInternalClient();
        return await client.patchOpenclawConfig(
          ctx.user.id,
          input.patch,
          workerInstanceId(instance)
        );
      } catch (err) {
        handleFileOperationError(err, 'patch openclaw config');
      }
    }),

  // ── Billing endpoints ────────────────────────────────────────────────

  getBillingStatus: baseProcedure.query(async ({ ctx }) => {
    return await getPersonalBillingStatus(ctx.user);
  }),

  getActivePersonalBillingStatus: baseProcedure.query(async ({ ctx }) => {
    return await getPersonalBillingStatus(ctx.user);
  }),

  getPersonalBillingSummary: baseProcedure.query(async ({ ctx }) => {
    const billing = await getPersonalBillingStatus(ctx.user);
    return summarizePersonalBillingStatus(billing);
  }),

  // ── Personal subscription management ─────────────────────────────────

  listPersonalSubscriptions: baseProcedure
    .output(KiloclawPersonalSubscriptionsOutputSchema)
    .query(async ({ ctx }) => {
      const [rows, hasActiveKiloPass] = await Promise.all([
        listKiloclawPersonalSubscriptionRows(ctx.user.id),
        getHasActiveKiloPassForUser(ctx.user.id),
      ]);

      return {
        subscriptions: rows.map(row =>
          serializeKiloclawPersonalSubscription(row, hasActiveKiloPass)
        ),
      };
    }),

  getSubscriptionDetail: baseProcedure
    .input(KiloclawInstanceInputSchema)
    .output(KiloclawPersonalSubscriptionSchema)
    .query(async ({ ctx, input }) => {
      const [row, hasActiveKiloPass] = await Promise.all([
        getKiloclawPersonalSubscriptionRow({ userId: ctx.user.id, instanceId: input.instanceId }),
        getHasActiveKiloPassForUser(ctx.user.id),
      ]);

      return serializeKiloclawPersonalSubscription(row, hasActiveKiloPass);
    }),

  getBillingHistory: baseProcedure
    .input(KiloclawBillingHistoryInputSchema)
    .output(billingHistoryResponseSchema)
    .query(async ({ ctx, input }) => {
      const row = await getKiloclawPersonalSubscriptionRow({
        userId: ctx.user.id,
        instanceId: input.instanceId,
      });

      if (row.subscription.stripe_subscription_id) {
        const invoices = await stripe.invoices.list({
          subscription: row.subscription.stripe_subscription_id,
          limit: 25,
          ...(input.cursor ? { starting_after: input.cursor } : {}),
        });

        return {
          entries: invoices.data.map(mapStripeInvoiceToBillingHistoryEntry),
          hasMore: invoices.has_more,
          cursor: invoices.has_more ? (invoices.data.at(-1)?.id ?? null) : null,
        };
      }

      const offset = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
      const relatedInstances = await db
        .select({ id: kiloclaw_instances.id })
        .from(kiloclaw_instances)
        .where(
          and(
            eq(kiloclaw_instances.user_id, ctx.user.id),
            isNull(kiloclaw_instances.organization_id),
            eq(kiloclaw_instances.sandbox_id, row.instance.sandboxId)
          )
        );
      const relatedInstanceIds = relatedInstances.map(instance => instance.id);
      const deductionCategoryPrefixes = [
        ...relatedInstanceIds.map(instanceId => `kiloclaw-subscription:${instanceId}:%`),
        ...relatedInstanceIds.map(instanceId => `kiloclaw-subscription-commit:${instanceId}:%`),
      ];

      const transactions = await db
        .select({
          id: credit_transactions.id,
          date: credit_transactions.created_at,
          description: credit_transactions.description,
          amountMicrodollars: credit_transactions.amount_microdollars,
        })
        .from(credit_transactions)
        .where(
          and(
            eq(credit_transactions.kilo_user_id, ctx.user.id),
            isNull(credit_transactions.organization_id),
            or(
              ...deductionCategoryPrefixes.map(prefix =>
                like(credit_transactions.credit_category, prefix)
              )
            )
          )
        )
        .orderBy(desc(credit_transactions.created_at), desc(credit_transactions.id))
        .limit(26)
        .offset(offset);

      return {
        entries: transactions.slice(0, 25).map(transaction => ({
          kind: 'credits' as const,
          id: transaction.id,
          date: normalizeTimestamp(transaction.date) ?? transaction.date,
          amountMicrodollars: Math.abs(transaction.amountMicrodollars),
          description: transaction.description ?? 'Hosting renewal',
        })),
        hasMore: transactions.length > 25,
        cursor: transactions.length > 25 ? String(offset + 25) : null,
      };
    }),

  getCustomerPortalUrl: baseProcedure
    .input(KiloclawCustomerPortalInputSchema)
    .output(z.object({ url: z.url() }))
    .mutation(async ({ ctx, input }) => {
      const row = await getKiloclawPersonalSubscriptionRow({
        userId: ctx.user.id,
        instanceId: input.instanceId,
      });

      if (!row.subscription.stripe_subscription_id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This subscription is not Stripe-funded.',
        });
      }

      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer.' });
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: input.returnUrl ?? `${APP_URL}/subscriptions/kiloclaw/${input.instanceId}`,
      });

      return { url: session.url };
    }),

  cancelSubscriptionAtInstance: baseProcedure
    .input(KiloclawInstanceInputSchema)
    .output(KiloclawMutationResultSchema)
    .mutation(async ({ ctx, input }) => {
      const row = await getKiloclawPersonalSubscriptionRow({
        userId: ctx.user.id,
        instanceId: input.instanceId,
      });
      await cancelKiloclawSubscriptionForRow({
        subscription: row.subscription,
        userId: ctx.user.id,
      });
      return { success: true };
    }),

  acceptConversionAtInstance: baseProcedure
    .input(KiloclawInstanceInputSchema)
    .output(KiloclawMutationResultSchema)
    .mutation(async ({ ctx, input }) => {
      const row = await getKiloclawPersonalSubscriptionRow({
        userId: ctx.user.id,
        instanceId: input.instanceId,
      });
      await acceptKiloclawConversionForRow({
        subscription: row.subscription,
        userId: ctx.user.id,
      });
      return { success: true };
    }),

  reactivateSubscriptionAtInstance: baseProcedure
    .input(KiloclawInstanceInputSchema)
    .output(KiloclawMutationResultSchema)
    .mutation(async ({ ctx, input }) => {
      const row = await getKiloclawPersonalSubscriptionRow({
        userId: ctx.user.id,
        instanceId: input.instanceId,
      });
      await reactivateKiloclawSubscriptionForRow({
        subscription: row.subscription,
        userId: ctx.user.id,
      });
      return { success: true };
    }),

  switchPlanAtInstance: baseProcedure
    .input(KiloclawInstanceSwitchPlanInputSchema)
    .output(KiloclawMutationResultSchema)
    .mutation(async ({ ctx, input }) => {
      const row = await getKiloclawPersonalSubscriptionRow({
        userId: ctx.user.id,
        instanceId: input.instanceId,
      });
      await switchKiloclawPlanForRow({
        subscription: row.subscription,
        toPlan: input.toPlan,
      });
      return { success: true };
    }),

  cancelPlanSwitchAtInstance: baseProcedure
    .input(KiloclawInstanceInputSchema)
    .output(KiloclawMutationResultSchema)
    .mutation(async ({ ctx, input }) => {
      const row = await getKiloclawPersonalSubscriptionRow({
        userId: ctx.user.id,
        instanceId: input.instanceId,
      });
      await cancelKiloclawPlanSwitchForRow({
        subscription: row.subscription,
        userId: ctx.user.id,
      });
      return { success: true };
    }),

  createSubscriptionCheckout: baseProcedure
    .input(KiloclawOptionalInstanceInputSchema.extend({ plan: z.enum(['commit', 'standard']) }))
    .mutation(async ({ ctx, input }) => {
      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer for user.' });
      }

      const { anchorInstance } = await resolvePersonalBillingAnchor({
        userId: ctx.user.id,
        instanceId: input.instanceId,
      });
      if (!anchorInstance) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Provision KiloClaw first before starting paid hosting checkout.',
        });
      }

      const hasBlockingSubscription = await hasBlockingPersonalKiloclawSubscriptionAtInstance({
        userId: ctx.user.id,
        instanceId: anchorInstance.id,
      });
      if (hasBlockingSubscription) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You already have an active subscription.',
        });
      }

      // Guard against duplicate Stripe subscriptions: the DB check above exempts
      // trialing rows, so also verify against live Stripe state.
      const [activeSubs, trialingSubs, openSessions] = await Promise.all([
        stripe.subscriptions.list({ customer: stripeCustomerId, status: 'active', limit: 10 }),
        stripe.subscriptions.list({ customer: stripeCustomerId, status: 'trialing', limit: 10 }),
        stripe.checkout.sessions.list({ customer: stripeCustomerId, status: 'open', limit: 10 }),
      ]);
      const hasActiveKiloClawSub = [...activeSubs.data, ...trialingSubs.data].some(
        s =>
          s.metadata.type === 'kiloclaw' &&
          (s.metadata.billingContext === 'personal' || !s.metadata.billingContext) &&
          s.metadata.instanceId === anchorInstance.id
      );
      if (hasActiveKiloClawSub) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You already have an active subscription.',
        });
      }
      // Best-effort: expire stale open checkout sessions so the user can retry.
      // Concurrent duplicates are tolerable — hasActiveKiloClawSub prevents
      // duplicate subscriptions, which is what actually matters.
      const staleKiloClawSessions = openSessions.data.filter(
        s => s.metadata?.type === 'kiloclaw' && s.metadata.instanceId === anchorInstance.id
      );
      await Promise.all(
        staleKiloClawSessions.map(s => stripe.checkout.sessions.expire(s.id).catch(() => {}))
      );

      // Intro pricing eligibility (spec Credit Enrollment rule 3).
      const hadPaidSubscription = await hadPriorPaidSubscription(ctx.user.id);
      const priceId =
        input.plan === 'standard' && !hadPaidSubscription
          ? getStripePriceIdForClawPlanIntro('standard')
          : getStripePriceIdForClawPlan(input.plan);

      const attribution = await getAffiliateAttribution(ctx.user.id, 'impact');
      const sessionMetadata = {
        type: 'kiloclaw',
        billingContext: 'personal',
        plan: input.plan,
        kiloUserId: ctx.user.id,
        affiliateTrackingId: attribution?.tracking_id ?? '',
        instanceId: anchorInstance.id,
      };
      const successUrl = `${APP_URL}/payments/kiloclaw/success?session_id={CHECKOUT_SESSION_ID}&clawInstanceId=${anchorInstance.id}`;
      const cancelUrl = `${APP_URL}/claw?checkout=cancelled&clawInstanceId=${anchorInstance.id}`;

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeCustomerId,
        billing_address_collection: 'required',
        line_items: [{ price: priceId, quantity: 1 }],
        allow_promotion_codes: true,
        customer_update: { name: 'auto', address: 'auto' },
        tax_id_collection: { enabled: true, required: 'never' },
        success_url: successUrl,
        cancel_url: cancelUrl,
        subscription_data: {
          metadata: sessionMetadata,
        },
        metadata: sessionMetadata,
      });

      return { url: typeof session.url === 'string' ? session.url : null };
    }),

  enrollWithCredits: baseProcedure
    .input(
      z.object({
        plan: z.enum(['commit', 'standard']),
        instanceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { anchorInstance } = await resolvePersonalBillingAnchor({
        userId: ctx.user.id,
        instanceId: input.instanceId,
      });
      if (!anchorInstance) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Provision KiloClaw first before enrolling hosting with credits.',
        });
      }

      // Intro pricing eligibility (spec Credit Enrollment rule 3).
      const hadPaidSubscription = await hadPriorPaidSubscription(ctx.user.id);

      try {
        await enrollWithCreditsImpl({
          userId: ctx.user.id,
          instanceId: anchorInstance.id,
          plan: input.plan,
          hadPaidSubscription,
          actor: {
            actorType: 'user',
            actorId: ctx.user.id,
          },
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        const message = error instanceof Error ? error.message : 'Credit enrollment failed';
        const code = message.includes('not found')
          ? 'NOT_FOUND'
          : message.includes('already exists') || message.includes('already processed')
            ? 'CONFLICT'
            : message.includes('Insufficient credit balance')
              ? 'BAD_REQUEST'
              : 'INTERNAL_SERVER_ERROR';
        throw new TRPCError({ code, message, cause: error });
      }

      return { success: true };
    }),

  createKiloPassUpsellCheckout: baseProcedure
    .input(
      z.object({
        instanceId: z.string().uuid().optional(),
        tier: z.enum(['19', '49', '199']),
        cadence: z.enum(['monthly', 'yearly']),
        hostingPlan: z.enum(['commit', 'standard']),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer for user.' });
      }

      const { anchorInstance } = await resolvePersonalBillingAnchor({
        userId: ctx.user.id,
        instanceId: input.instanceId,
      });
      if (!anchorInstance) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Provision KiloClaw first before starting Kilo Pass hosting activation.',
        });
      }

      const hasBlockingSubscription = await hasBlockingPersonalKiloclawSubscriptionAtInstance({
        userId: ctx.user.id,
        instanceId: anchorInstance.id,
      });
      if (hasBlockingSubscription) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You already have an active subscription.',
        });
      }

      // Reject if user already has an active Kilo Pass subscription
      const existingKiloPass = await getKiloPassStateForUser(db, ctx.user.id);
      if (existingKiloPass && !isStripeSubscriptionEnded(existingKiloPass.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You already have an active Kilo Pass subscription.',
        });
      }

      const tierMap = {
        '19': KiloPassTier.Tier19,
        '49': KiloPassTier.Tier49,
        '199': KiloPassTier.Tier199,
      } as const;
      const cadenceMap = {
        monthly: KiloPassCadence.Monthly,
        yearly: KiloPassCadence.Yearly,
      } as const;

      const kiloPassTier = tierMap[input.tier];
      const kiloPassCadence = cadenceMap[input.cadence];
      if (
        input.hostingPlan === 'commit' &&
        !isKiloPassSelectionEligibleForKiloclawCommitUpsell({
          tier: kiloPassTier,
          cadence: kiloPassCadence,
          commitCostMicrodollars: KILOCLAW_PLAN_COST_MICRODOLLARS.commit,
        })
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Selected Kilo Pass option does not include enough credits for commit hosting.',
        });
      }

      const priceId = getStripePriceIdForKiloPass({
        tier: kiloPassTier,
        cadence: kiloPassCadence,
      });

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeCustomerId,
        allow_promotion_codes: true,
        billing_address_collection: 'required',
        line_items: [{ price: priceId, quantity: 1 }],
        customer_update: {
          name: 'auto',
          address: 'auto',
        },
        tax_id_collection: {
          enabled: true,
          required: 'never',
        },
        success_url: `${APP_URL}/payments/kilo-pass/awarding?session_id={CHECKOUT_SESSION_ID}&clawHostingPlan=${input.hostingPlan}&clawInstanceId=${anchorInstance.id}`,
        cancel_url: `${APP_URL}/claw?checkout=cancelled`,
        subscription_data: {
          metadata: {
            type: 'kilo-pass',
            kiloUserId: ctx.user.id,
            tier: kiloPassTier,
            cadence: kiloPassCadence,
          },
        },
        metadata: {
          type: 'kilo-pass',
          kiloUserId: ctx.user.id,
          tier: kiloPassTier,
          cadence: kiloPassCadence,
        },
      });

      return { url: typeof session.url === 'string' ? session.url : null };
    }),

  cancelSubscription: baseProcedure.mutation(async ({ ctx }) => {
    const { subscription: sub } = await getDisplayedPersonalKiloclawSubscription({
      userId: ctx.user.id,
    });

    if (!sub || sub.status !== 'active') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'No active subscription to cancel.' });
    }

    if (sub.cancel_at_period_end) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Subscription is already set to cancel.',
      });
    }

    if (sub.stripe_subscription_id) {
      // Stripe-funded path (legacy Stripe or hybrid)
      // Reconcile hidden-schedule state: Stripe may have an attached schedule
      // that the DB doesn't know about.
      const liveSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      const scheduleIdToRelease = sub.stripe_schedule_id ?? resolveScheduleId(liveSub.schedule);

      if (scheduleIdToRelease) {
        const released = await releaseScheduleIfActive(scheduleIdToRelease);
        if (!released) {
          logBillingError('Failed to release subscription schedule — aborting cancellation', {
            user_id: ctx.user.id,
            schedule_id: scheduleIdToRelease,
          });
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Unable to cancel: failed to release pending plan schedule. Please try again.',
          });
        }
      }

      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        cancel_at_period_end: true,
      });

      const cancelLog = await db.transaction(async tx => {
        const [before] = await tx
          .select()
          .from(kiloclaw_subscriptions)
          .where(eq(kiloclaw_subscriptions.id, sub.id))
          .limit(1);

        const [after] = await tx
          .update(kiloclaw_subscriptions)
          .set({
            cancel_at_period_end: true,
            ...(scheduleIdToRelease
              ? { stripe_schedule_id: null, scheduled_plan: null, scheduled_by: null }
              : {}),
          })
          .where(eq(kiloclaw_subscriptions.id, sub.id))
          .returning();

        return before && after
          ? {
              before,
              after,
            }
          : null;
      });

      if (cancelLog) {
        await insertUserSubscriptionChangeLogBestEffort({
          subscriptionId: sub.id,
          userId: ctx.user.id,
          action: 'canceled',
          reason: KILOCLAW_USER_SUBSCRIPTION_CHANGE_REASON.cancelRequested,
          before: cancelLog.before,
          after: cancelLog.after,
        });
      }
    } else if (sub.payment_source === 'credits') {
      // Pure credit path — local DB only, no Stripe API call
      await db.transaction(async tx => {
        const [before] = await tx
          .select()
          .from(kiloclaw_subscriptions)
          .where(eq(kiloclaw_subscriptions.id, sub.id))
          .limit(1);

        const [after] = await tx
          .update(kiloclaw_subscriptions)
          .set({
            cancel_at_period_end: true,
            // Clear all schedule state — a pure credit row should not have a Stripe
            // schedule, but clear defensively in case of stale data from a prior
            // Stripe-funded period.
            stripe_schedule_id: null,
            scheduled_plan: null,
            scheduled_by: null,
          })
          .where(eq(kiloclaw_subscriptions.id, sub.id))
          .returning();

        if (before && after) {
          await insertUserSubscriptionChangeLog(tx, {
            subscriptionId: sub.id,
            userId: ctx.user.id,
            action: 'canceled',
            reason: KILOCLAW_USER_SUBSCRIPTION_CHANGE_REASON.cancelRequested,
            before,
            after,
          });
        }
      });
    } else {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message:
          'Subscription is in an invalid state: no Stripe subscription and not credit-funded.',
      });
    }

    return { success: true };
  }),

  acceptConversion: baseProcedure.mutation(async ({ ctx }) => {
    // Resolve the active instance so we read the correct subscription row
    const instance = await getActiveInstance(ctx.user.id);
    if (!instance) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'No active instance found.' });
    }

    // Validate: user must have an active Stripe-funded subscription for this instance
    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(
        and(
          eq(kiloclaw_subscriptions.user_id, ctx.user.id),
          eq(kiloclaw_subscriptions.instance_id, instance.id)
        )
      )
      .limit(1);

    if (!sub || sub.status !== 'active') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'No active subscription to convert.' });
    }

    if (!sub.stripe_subscription_id) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Subscription is not Stripe-funded — nothing to convert.',
      });
    }

    if (sub.cancel_at_period_end) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Subscription is already set to cancel.',
      });
    }

    // Validate: user must have an active Kilo Pass
    const kiloPassState = await getKiloPassStateForUser(db, ctx.user.id);
    if (!kiloPassState || isStripeSubscriptionEnded(kiloPassState.status)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Active Kilo Pass required to convert to credit-funded billing.',
      });
    }

    // Same Stripe operations as cancelSubscription: release schedule + cancel at period end
    const liveSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    const scheduleIdToRelease = sub.stripe_schedule_id ?? resolveScheduleId(liveSub.schedule);

    if (scheduleIdToRelease) {
      const released = await releaseScheduleIfActive(scheduleIdToRelease);
      if (!released) {
        logBillingError('Failed to release subscription schedule — aborting conversion', {
          user_id: ctx.user.id,
          schedule_id: scheduleIdToRelease,
        });
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Unable to convert: failed to release pending plan schedule. Please try again.',
        });
      }
    }

    // Phase 1: Persist conversion intent and clear schedule fields before
    // the Stripe API call. We intentionally do NOT set cancel_at_period_end
    // here — that only happens after Stripe confirms (phase 2). This makes
    // the operation retry-safe: on failure the guard (cancel_at_period_end
    // === false) still allows re-entry, schedule release is idempotent, and
    // pending_conversion is already durable so subscription.deleted converts
    // correctly even if Stripe applied the change before the error was raised.
    await db.transaction(async tx => {
      const [before] = await tx
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.id, sub.id))
        .limit(1);

      const [after] = await tx
        .update(kiloclaw_subscriptions)
        .set({
          pending_conversion: true,
          ...(scheduleIdToRelease
            ? { stripe_schedule_id: null, scheduled_plan: null, scheduled_by: null }
            : {}),
        })
        .where(eq(kiloclaw_subscriptions.id, sub.id))
        .returning();

      if (before && after) {
        await insertUserSubscriptionChangeLog(tx, {
          subscriptionId: sub.id,
          userId: ctx.user.id,
          action: 'status_changed',
          reason: KILOCLAW_USER_SUBSCRIPTION_CHANGE_REASON.conversionPrepared,
          before,
          after,
        });
      }
    });

    // Phase 2: Tell Stripe to cancel at period end, then record locally.
    // If the Stripe call fails we reconcile by re-fetching the subscription
    // to check whether cancel_at_period_end was actually applied. This
    // prevents leaving pending_conversion armed after a definite rejection
    // while still handling timeout-after-commit safely.
    try {
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
    } catch (stripeError) {
      // Reconcile: did Stripe actually apply cancel_at_period_end?
      let stripeApplied: boolean | undefined;
      try {
        const refreshed = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
        stripeApplied = refreshed.cancel_at_period_end === true;
      } catch {
        // Re-fetch failed — ambiguous. Leave pending_conversion armed so
        // subscription.deleted converts correctly if Stripe did commit.
        stripeApplied = undefined;
      }

      if (stripeApplied === false) {
        // Stripe definitively did NOT apply the change. Roll back the
        // conversion intent so an unrelated subscription.deleted event
        // won't incorrectly trigger the conversion path.
        const rollbackLog = await db.transaction(async tx => {
          const [before] = await tx
            .select()
            .from(kiloclaw_subscriptions)
            .where(eq(kiloclaw_subscriptions.id, sub.id))
            .limit(1);

          const [after] = await tx
            .update(kiloclaw_subscriptions)
            .set({ pending_conversion: false })
            .where(eq(kiloclaw_subscriptions.id, sub.id))
            .returning();

          return before && after
            ? {
                before,
                after,
              }
            : null;
        });

        if (rollbackLog) {
          await insertUserSubscriptionChangeLogBestEffort({
            subscriptionId: sub.id,
            userId: ctx.user.id,
            action: 'status_changed',
            reason: KILOCLAW_USER_SUBSCRIPTION_CHANGE_REASON.conversionPrepareRolledBack,
            before: rollbackLog.before,
            after: rollbackLog.after,
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to schedule Stripe cancellation. Please try again.',
          cause: stripeError,
        });
      }

      if (stripeApplied === undefined) {
        // Both calls failed — we cannot confirm Stripe's state. Leave
        // pending_conversion armed (safe: if Stripe did commit, the
        // subscription.deleted handler will convert correctly). But do
        // NOT set cancel_at_period_end locally or return success —
        // doing so would block retries and could permanently desync
        // local state if Stripe never applied the change.
        logBillingError(
          'acceptConversion: Stripe update threw and re-fetch also failed — state ambiguous, will retry',
          {
            user_id: ctx.user.id,
            stripe_subscription_id: sub.stripe_subscription_id,
            error: stripeError instanceof Error ? stripeError.message : String(stripeError),
          }
        );

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Unable to confirm Stripe cancellation. Please try again.',
          cause: stripeError,
        });
      }

      // stripeApplied === true: timeout-after-commit case. Stripe
      // confirmed cancel_at_period_end — fall through to persist locally.
    }

    const conversionLog = await db.transaction(async tx => {
      const [before] = await tx
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.id, sub.id))
        .limit(1);

      const [after] = await tx
        .update(kiloclaw_subscriptions)
        .set({ cancel_at_period_end: true })
        .where(eq(kiloclaw_subscriptions.id, sub.id))
        .returning();

      return before && after
        ? {
            before,
            after,
          }
        : null;
    });

    if (conversionLog) {
      await insertUserSubscriptionChangeLogBestEffort({
        subscriptionId: sub.id,
        userId: ctx.user.id,
        action: 'canceled',
        reason: KILOCLAW_USER_SUBSCRIPTION_CHANGE_REASON.conversionRequested,
        before: conversionLog.before,
        after: conversionLog.after,
      });
    }

    return { success: true };
  }),

  reactivateSubscription: baseProcedure.mutation(async ({ ctx }) => {
    const { subscription: sub } = await getDisplayedPersonalKiloclawSubscription({
      userId: ctx.user.id,
    });

    if (!sub || sub.status !== 'active' || !sub.cancel_at_period_end) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No pending cancellation to reactivate.',
      });
    }

    if (sub.stripe_subscription_id) {
      // Stripe-funded path (legacy Stripe or hybrid)
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        cancel_at_period_end: false,
      });
      const reactivationLog = await db.transaction(async tx => {
        const [before] = await tx
          .select()
          .from(kiloclaw_subscriptions)
          .where(eq(kiloclaw_subscriptions.id, sub.id))
          .limit(1);

        const [after] = await tx
          .update(kiloclaw_subscriptions)
          .set({ cancel_at_period_end: false, pending_conversion: false })
          .where(eq(kiloclaw_subscriptions.id, sub.id))
          .returning();

        return before && after
          ? {
              before,
              after,
            }
          : null;
      });

      if (reactivationLog) {
        await insertUserSubscriptionChangeLogBestEffort({
          subscriptionId: sub.id,
          userId: ctx.user.id,
          action: 'reactivated',
          reason: KILOCLAW_USER_SUBSCRIPTION_CHANGE_REASON.reactivated,
          before: reactivationLog.before,
          after: reactivationLog.after,
        });
      }

      // Best-effort: restore the auto intro→regular schedule if on an intro price
      try {
        await ensureAutoIntroSchedule(sub.stripe_subscription_id, ctx.user.id);
      } catch (err) {
        logBillingError('Failed to restore auto intro schedule after reactivation', {
          user_id: ctx.user.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (sub.payment_source === 'credits') {
      // Pure credit path — local DB only, no Stripe API call
      await db.transaction(async tx => {
        const [before] = await tx
          .select()
          .from(kiloclaw_subscriptions)
          .where(eq(kiloclaw_subscriptions.id, sub.id))
          .limit(1);

        const [after] = await tx
          .update(kiloclaw_subscriptions)
          .set({ cancel_at_period_end: false, pending_conversion: false })
          .where(eq(kiloclaw_subscriptions.id, sub.id))
          .returning();

        if (before && after) {
          await insertUserSubscriptionChangeLog(tx, {
            subscriptionId: sub.id,
            userId: ctx.user.id,
            action: 'reactivated',
            reason: KILOCLAW_USER_SUBSCRIPTION_CHANGE_REASON.reactivated,
            before,
            after,
          });
        }
      });
    } else {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message:
          'Subscription is in an invalid state: no Stripe subscription and not credit-funded.',
      });
    }

    return { success: true };
  }),

  switchPlan: baseProcedure
    .input(z.object({ toPlan: z.enum(['commit', 'standard']) }))
    .mutation(async ({ ctx, input }) => {
      const { subscription: sub } = await getDisplayedPersonalKiloclawSubscription({
        userId: ctx.user.id,
      });

      if (!sub || sub.status !== 'active') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No active subscription to switch.' });
      }

      if (sub.plan === input.toPlan) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Already on this plan.' });
      }

      if (sub.plan !== 'commit' && sub.plan !== 'standard') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot switch from a trial plan.' });
      }

      if (sub.stripe_subscription_id) {
        // Stripe-funded path (legacy Stripe or hybrid)

        // Reconcile hidden-schedule state: Stripe may have an attached schedule
        // that the DB doesn't know about.
        const liveSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
        const effectiveScheduleId = sub.stripe_schedule_id ?? resolveScheduleId(liveSub.schedule);

        let effectiveScheduledBy = sub.scheduled_by;
        if (!sub.stripe_schedule_id && effectiveScheduleId) {
          const hiddenSchedule = await stripe.subscriptionSchedules.retrieve(effectiveScheduleId);
          if (hiddenSchedule.metadata?.origin === 'auto-intro') {
            effectiveScheduledBy = 'auto';
          } else {
            // Hidden non-auto schedule — must release before creating a fresh one,
            // otherwise Stripe rejects the create because the subscription is still
            // attached to the old schedule.
            const released = await releaseScheduleIfActive(effectiveScheduleId);
            if (!released) {
              throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message:
                  'Unable to switch plan: failed to release existing schedule. Please try again.',
              });
            }
            effectiveScheduledBy = null;
          }
        }

        if (effectiveScheduledBy === 'user') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'A plan switch is already pending. Cancel it before requesting a new one.',
          });
        }

        const targetPriceId = getStripePriceIdForClawPlan(input.toPlan);

        // If an auto schedule exists, update it in place for the user's plan switch.
        if (effectiveScheduledBy === 'auto' && effectiveScheduleId) {
          try {
            const existingSchedule =
              await stripe.subscriptionSchedules.retrieve(effectiveScheduleId);
            const autoCurrentPhase = existingSchedule.phases[0];
            const phase1Price = autoCurrentPhase ? resolvePhasePrice(autoCurrentPhase) : null;

            if (!autoCurrentPhase || !phase1Price) {
              throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Cannot determine current phase price from schedule.',
              });
            }

            await stripe.subscriptionSchedules.update(effectiveScheduleId, {
              end_behavior: 'release',
              phases: [
                {
                  items: [{ price: phase1Price }],
                  start_date: autoCurrentPhase.start_date,
                  end_date: autoCurrentPhase.end_date,
                },
                { items: [{ price: targetPriceId }] },
              ],
            });

            const scheduleLog = await db.transaction(async tx => {
              const [before] = await tx
                .select()
                .from(kiloclaw_subscriptions)
                .where(eq(kiloclaw_subscriptions.id, sub.id))
                .limit(1);

              const [after] = await tx
                .update(kiloclaw_subscriptions)
                .set({
                  stripe_schedule_id: effectiveScheduleId,
                  scheduled_plan: input.toPlan,
                  scheduled_by: 'user',
                })
                .where(eq(kiloclaw_subscriptions.id, sub.id))
                .returning();

              return before && after
                ? {
                    before,
                    after,
                  }
                : null;
            });

            if (scheduleLog) {
              await insertUserSubscriptionChangeLogBestEffort({
                subscriptionId: sub.id,
                userId: ctx.user.id,
                action: 'schedule_changed',
                reason: KILOCLAW_USER_SUBSCRIPTION_CHANGE_REASON.switchPlanScheduled,
                before: scheduleLog.before,
                after: scheduleLog.after,
              });
            }

            return { success: true };
          } catch (err) {
            // Stale schedule — clear pointer and fall through to fresh creation
            if (!isScheduleAlreadyInactive(err)) throw err;

            await db
              .update(kiloclaw_subscriptions)
              .set({ stripe_schedule_id: null, scheduled_plan: null, scheduled_by: null })
              .where(eq(kiloclaw_subscriptions.id, sub.id));
          }
        }

        // Fresh schedule creation: no existing schedule (or stale one was cleared above).
        // from_subscription mirrors the subscription's current state at create-time,
        // so the phase price reflects the actual current price even if a schedule
        // released at a billing boundary since our earlier subscriptions.retrieve().
        let stripeScheduleId: string | null = null;
        try {
          const schedule = await stripe.subscriptionSchedules.create({
            from_subscription: sub.stripe_subscription_id,
          });
          stripeScheduleId = schedule.id;

          const currentPhase = schedule.phases[0];
          if (!currentPhase) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Stripe schedule has no current phase.',
            });
          }

          const freshPhase1Price = resolvePhasePrice(currentPhase);
          if (!freshPhase1Price) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Cannot determine current subscription price from schedule.',
            });
          }

          await stripe.subscriptionSchedules.update(schedule.id, {
            metadata: { origin: 'user-switch' },
            end_behavior: 'release',
            phases: [
              {
                items: [{ price: freshPhase1Price }],
                start_date: currentPhase.start_date,
                end_date: currentPhase.end_date,
              },
              { items: [{ price: targetPriceId }] },
            ],
          });

          // Optimistic concurrency: only write if no other request wrote a schedule first.
          const scheduleLog = await db.transaction(async tx => {
            const [before] = await tx
              .select()
              .from(kiloclaw_subscriptions)
              .where(eq(kiloclaw_subscriptions.id, sub.id))
              .limit(1);

            const [after] = await tx
              .update(kiloclaw_subscriptions)
              .set({
                stripe_schedule_id: schedule.id,
                scheduled_plan: input.toPlan,
                scheduled_by: 'user',
              })
              .where(
                and(
                  eq(kiloclaw_subscriptions.id, sub.id),
                  isNull(kiloclaw_subscriptions.stripe_schedule_id)
                )
              )
              .returning();

            return before && after
              ? {
                  before,
                  after,
                }
              : null;
          });

          if (!scheduleLog) {
            // A concurrent request already wrote a schedule — release ours.
            await stripe.subscriptionSchedules.release(schedule.id);
            stripeScheduleId = null; // Already cleaned up; skip catch-block cleanup.
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'A plan switch is already pending. Cancel it before requesting a new one.',
            });
          }

          await insertUserSubscriptionChangeLogBestEffort({
            subscriptionId: sub.id,
            userId: ctx.user.id,
            action: 'schedule_changed',
            reason: KILOCLAW_USER_SUBSCRIPTION_CHANGE_REASON.switchPlanScheduled,
            before: scheduleLog.before,
            after: scheduleLog.after,
          });

          return { success: true };
        } catch (error) {
          // Best-effort cleanup: if we created a schedule on Stripe but something
          // failed afterward, release it so it doesn't become orphaned.
          if (stripeScheduleId) {
            try {
              await stripe.subscriptionSchedules.release(stripeScheduleId);
            } catch {
              // Swallow cleanup errors — the original error is more important.
            }
          }
          throw error;
        }
      } else if (sub.payment_source === 'credits') {
        // Pure credit path — record scheduled plan locally, applied at next
        // period boundary by the credit renewal sweep (spec Plan Switching rule 9).

        if (sub.scheduled_plan && sub.scheduled_by === 'user') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'A plan switch is already pending. Cancel it before requesting a new one.',
          });
        }

        await db.transaction(async tx => {
          const [before] = await tx
            .select()
            .from(kiloclaw_subscriptions)
            .where(eq(kiloclaw_subscriptions.id, sub.id))
            .limit(1);

          const [after] = await tx
            .update(kiloclaw_subscriptions)
            .set({ scheduled_plan: input.toPlan, scheduled_by: 'user' })
            .where(eq(kiloclaw_subscriptions.id, sub.id))
            .returning();

          if (before && after) {
            await insertUserSubscriptionChangeLog(tx, {
              subscriptionId: sub.id,
              userId: ctx.user.id,
              action: 'schedule_changed',
              reason: KILOCLAW_USER_SUBSCRIPTION_CHANGE_REASON.switchPlanScheduled,
              before,
              after,
            });
          }
        });

        return { success: true };
      } else {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message:
            'Subscription is in an invalid state: no Stripe subscription and not credit-funded.',
        });
      }
    }),

  cancelPlanSwitch: baseProcedure.mutation(async ({ ctx }) => {
    const { subscription: sub } = await getDisplayedPersonalKiloclawSubscription({
      userId: ctx.user.id,
    });

    if (!sub?.scheduled_plan) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'No pending plan switch to cancel.' });
    }

    if (sub.scheduled_by !== 'user') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No user-initiated plan switch to cancel.',
      });
    }

    if (sub.stripe_schedule_id) {
      // Stripe-funded path — release the Stripe schedule
      const released = await releaseScheduleIfActive(sub.stripe_schedule_id);
      if (!released) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to release pending plan schedule. Please try again.',
        });
      }

      const cancelPlanSwitchLog = await db.transaction(async tx => {
        const [before] = await tx
          .select()
          .from(kiloclaw_subscriptions)
          .where(eq(kiloclaw_subscriptions.id, sub.id))
          .limit(1);

        const [after] = await tx
          .update(kiloclaw_subscriptions)
          .set({ stripe_schedule_id: null, scheduled_plan: null, scheduled_by: null })
          .where(eq(kiloclaw_subscriptions.id, sub.id))
          .returning();

        return before && after
          ? {
              before,
              after,
            }
          : null;
      });

      if (cancelPlanSwitchLog) {
        await insertUserSubscriptionChangeLogBestEffort({
          subscriptionId: sub.id,
          userId: ctx.user.id,
          action: 'schedule_changed',
          reason: KILOCLAW_USER_SUBSCRIPTION_CHANGE_REASON.switchPlanCanceled,
          before: cancelPlanSwitchLog.before,
          after: cancelPlanSwitchLog.after,
        });
      }

      // Best-effort: restore the auto intro→regular schedule if on an intro price
      try {
        if (sub.stripe_subscription_id) {
          await ensureAutoIntroSchedule(sub.stripe_subscription_id, ctx.user.id);
        }
      } catch (err) {
        logBillingError('Failed to restore auto intro schedule after cancel plan switch', {
          user_id: ctx.user.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // Pure credit path — clear locally recorded scheduled plan only
      await db.transaction(async tx => {
        const [before] = await tx
          .select()
          .from(kiloclaw_subscriptions)
          .where(eq(kiloclaw_subscriptions.id, sub.id))
          .limit(1);

        const [after] = await tx
          .update(kiloclaw_subscriptions)
          .set({ scheduled_plan: null, scheduled_by: null })
          .where(eq(kiloclaw_subscriptions.id, sub.id))
          .returning();

        if (before && after) {
          await insertUserSubscriptionChangeLog(tx, {
            subscriptionId: sub.id,
            userId: ctx.user.id,
            action: 'schedule_changed',
            reason: KILOCLAW_USER_SUBSCRIPTION_CHANGE_REASON.switchPlanCanceled,
            before,
            after,
          });
        }
      });
    }

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

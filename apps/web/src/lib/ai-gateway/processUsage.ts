import { randomUUID } from 'crypto';
import { db, isUSRegion } from '../drizzle';
import { recordUsageInPrimaryRegion } from './usage-record-client';
import {
  describeDatabaseError,
  isUsageRowConflict,
  stackFramesUnderHeader,
} from './usage-record-diagnostics';
import type { MicrodollarUsage } from '@kilocode/db/schema';
import { microdollar_usage } from '@kilocode/db/schema';
import { createTimer } from '@/lib/timer';
import type { OpenAI } from 'openai';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import type {
  OpenRouterChatCompletionRequest,
  OpenRouterGeneration,
} from './providers/openrouter/types';
import { fetchGeneration } from './providers/upstream-request';
import { OPENROUTER, VERCEL_AI_GATEWAY } from './providers/provider-definitions';
import { toMicrodollars } from '../utils';
import { captureException, captureMessage, startSpan, startInactiveSpan } from '@sentry/nextjs';
import type { Span } from '@sentry/nextjs';
import PostHogClient from '@/lib/posthog';
import { hasPaymentMethod } from '@/lib/admin-utils-serverside';
import type { SQL } from 'drizzle-orm';
import { and, eq, sql } from 'drizzle-orm';
import { sentryRootSpan } from '../getRootSpan';
import {
  mutateOrganizationUsage,
  scheduleOrganizationLowBalanceAlert,
} from '@/lib/organizations/organization-usage';
import type { OrganizationUsageMutationResult } from '@/lib/organizations/organization-usage';
import type { DrizzleTransaction } from '@/lib/drizzle';
import type { ProviderId } from '@/lib/ai-gateway/providers/types';
import {
  findKiloExclusiveModel,
  shouldRedactModelNameInMicrodollarUsage,
} from '@/lib/ai-gateway/models';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';
import { sentryLogger } from '@/lib/utils.server';
import { maybeIssueKiloPassBonusFromUsageThreshold } from '@/lib/kilo-pass/usage-triggered-bonus';
import { getEffectiveKiloPassThreshold } from '@/lib/kilo-pass/threshold';
import {
  runBestEffortPostCommitTasks,
  type BestEffortPostCommitTask,
} from './usage-post-commit-work';
import { appendKiloPassAuditLog } from '@/lib/kilo-pass/issuance';
import { KiloPassAuditLogAction, KiloPassAuditLogResult } from '@/lib/kilo-pass/enums';
import { reportAbuseCost } from '@/lib/ai-gateway/abuse-service';
import type {
  BalanceUpdateResult,
  ChatCompletionChunk,
  CoreUsageWithMetaData,
  JustTheCostsUsageStats,
  MaybeHasOpenRouterUsage,
  MaybeHasVercelProviderMetaData,
  Message,
  MicrodollarUsageContext,
  MicrodollarUsageStats,
  NotYetCostedUsageStats,
  OpenRouterError,
  OpenRouterUsage,
  PromptInfo,
  UsageMetaData,
  UsageRecordInsertResult,
  UsageRecordWriteOutcome,
  VercelProviderMetaData,
} from '@/lib/ai-gateway/processUsage.types';
import {
  parseResponsesMicrodollarUsageFromStream,
  parseResponsesMicrodollarUsageFromString,
} from '@/lib/ai-gateway/processUsage.responses';
import {
  parseMessagesMicrodollarUsageFromStream,
  parseMessagesMicrodollarUsageFromString,
} from '@/lib/ai-gateway/processUsage.messages';
import { OPENROUTER_BYOK_COST_MULTIPLIER } from '@/lib/ai-gateway/processUsage.constants';
import { isErrorFinishReason } from '@/lib/ai-gateway/finishReason';
import {
  computeOpenRouterCostFields,
  drainSseStream,
  extractVercelIsByok,
  extractVercelUpstreamId,
  isResponseInterruptedError,
} from '@/lib/ai-gateway/processUsage.shared';
import {
  calculateCost_mUsd,
  type KiloExclusiveModel,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { calculateCustomCost_mUsd } from '@/lib/ai-gateway/custom-pricing';
import { enqueueDailyUsageRollupRepair } from './usage-daily-rollup-repairs';
import { recordOrganizationConsumption } from '@/lib/kilo-pass-org/consumption';

const posthogClient = PostHogClient();

export function extractPromptInfo(body: OpenRouterChatCompletionRequest): PromptInfo {
  try {
    const messages = body.messages ?? [];

    const systemPrompt = messages
      .filter(m => m.role === 'system' || m.role === 'developer')
      .map(extractMessageTextContent)
      .join('\n');

    const system_prompt_prefix = systemPrompt.slice(0, 100);
    const system_prompt_length = systemPrompt.length;

    const lastUserMessage =
      messages
        .filter(m => m.role === 'user')
        .slice(-1)
        .map(extractMessageTextContent)[0] ?? '';

    const user_prompt_prefix = lastUserMessage.slice(0, 100);

    return { system_prompt_prefix, system_prompt_length, user_prompt_prefix };
  } catch (e) {
    captureException(e, {
      level: 'warning',
      tags: { source: 'prompt_extraction' },
      extra: { body },
    });
    return { system_prompt_prefix: '', system_prompt_length: -1, user_prompt_prefix: '' };
  }
}

const extractMessageTextContent = (m: Message) =>
  typeof m.content === 'string'
    ? m.content
    : Array.isArray(m.content)
      ? m.content
          .filter((c): c is { type?: string; text?: string } => c != null && c.type === 'text')
          .map(c => c.text)
          .join('\n')
      : '';

export type UsageContextInfo = ReturnType<typeof extractUsageContextInfo>;

export function extractUsageContextInfo(usageContext: MicrodollarUsageContext) {
  return {
    kilo_user_id: usageContext.kiloUserId,
    organization_id: usageContext.organizationId ?? null,
    ...usageContext.fraudHeaders,
    provider: usageContext.provider,
    ...usageContext.promptInfo,
    max_tokens: usageContext.max_tokens,
    has_middle_out_transform: usageContext.has_middle_out_transform,
    project_id: usageContext.project_id,
    requested_model: usageContext.requested_model,
    status_code: usageContext.status_code,
    editor_name: usageContext.editor_name,
    api_kind: usageContext.api_kind,
    machine_id: usageContext.machine_id,
    is_user_byok: usageContext.user_byok,
    has_tools: usageContext.has_tools,
    feature: usageContext.feature,
    session_id: usageContext.session_id,
    mode: usageContext.mode,
    auto_model: usageContext.auto_model,
    ttfb_ms: usageContext.ttfb_ms,
    abuse_delay: usageContext.abuse_delay ?? null,
    abuse_downgraded_from: usageContext.abuse_downgraded_from ?? null,
  };
}

/**
 * Strip NUL bytes (\u0000) in place from every string-typed field on `obj`.
 *
 * Postgres `text` columns reject NUL bytes with `22021 invalid byte sequence
 * for encoding "UTF8": 0x00`, which crashes the `microdollar_usage` CTE insert
 * and leaves the request un-billed (see Sentry KILOCODE-WEB-1G3Z).
 *
 * NULs have been observed in client-populated fields on the LLM gateway hot
 * path: HTTP headers from the VS Code extension (machine_id, session_id,
 * http_user_agent) and prompt-derived fields (system_prompt_prefix,
 * user_prompt_prefix). Sanitizing at the DB boundary is a safety net; once
 * the upstream source is identified via the `console.warn` in
 * `toInsertableDbUsageRecord` (queryable in Axiom), sanitize at the source
 * and remove this.
 *
 * Any sanitized field names are appended to `dirtyFields` so the caller can
 * log them for source attribution.
 */
export function stripNulBytesInPlace(obj: Record<string, unknown>, dirtyFields: string[]): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === 'string' && value.indexOf('\u0000') >= 0) {
      // Using split/join rather than a regex avoids the no-control-regex
      // lint rule; the NUL byte is the intended match here.
      obj[key] = value.split('\u0000').join('');
      dirtyFields.push(key);
    }
  }
}

export async function toInsertableDbUsageRecord(
  usageStats: MicrodollarUsageStats,
  usageContextInfo: UsageContextInfo
): Promise<CoreUsageWithMetaData> {
  const id = randomUUID();
  const created_at = new Date().toISOString();

  const { kilo_user_id, organization_id, project_id, provider, ttfb_ms, ...metadataFromContext } =
    usageContextInfo;

  const core: MicrodollarUsage = {
    id,
    kilo_user_id,
    organization_id,
    provider,
    cost: usageStats.cost_mUsd,
    input_tokens: usageStats.inputTokens,
    output_tokens: usageStats.outputTokens,
    cache_write_tokens: usageStats.cacheWriteTokens,
    cache_hit_tokens: usageStats.cacheHitTokens,
    created_at,
    model: usageStats.model,
    requested_model: usageContextInfo.requested_model,
    cache_discount: usageStats.cacheDiscount_mUsd ?? null,
    has_error: usageStats.hasError,
    abuse_classification: 0,
    inference_provider: usageStats.inference_provider,
    project_id,
  };

  const metadata: UsageMetaData = {
    ...metadataFromContext,
    id,
    created_at,
    message_id: usageStats.messageId ?? '<missing>',
    upstream_id: usageStats.upstream_id,
    finish_reason: usageStats.finish_reason,
    latency: usageStats.latency ?? ttfb_ms,
    moderation_latency: usageStats.moderation_latency,
    generation_time: usageStats.generation_time,
    is_byok: usageStats.is_byok,
    streamed: usageStats.streamed,
    cancelled: usageStats.cancelled,
    market_cost: usageStats.market_cost ?? null,
    is_free: await isFreeModel(usageContextInfo.requested_model),
    abuse_delay: metadataFromContext.abuse_delay,
    abuse_downgraded_from: metadataFromContext.abuse_downgraded_from,
  };

  // Legacy heuristic classification removed - abuse_classification is now handled
  // by the external abuse detection service in src/lib/abuse-service.ts
  if (organization_id) {
    //never log any sensitive data for orgs
    metadata.user_prompt_prefix = null;
    metadata.system_prompt_prefix = null;
  }

  // Strip NUL bytes before returning. Postgres `text` columns reject them
  // (error 22021) and crash the microdollar_usage CTE insert, leaving the
  // request un-billed. See KILOCODE-WEB-1G3Z.
  const dirtyFields: string[] = [];
  stripNulBytesInPlace(core as unknown as Record<string, unknown>, dirtyFields);
  stripNulBytesInPlace(metadata as unknown as Record<string, unknown>, dirtyFields);
  if (dirtyFields.length > 0) {
    // Log to Axiom (not Sentry) — this is a one-off source-attribution probe,
    // not an issue to triage. Once the dominant field is identified via
    // `summarize count() by fields`, sanitize at the source and remove both
    // this log and the sanitizer above.
    console.warn('microdollar_usage string field contained NUL bytes; sanitized before insert', {
      source: 'toInsertableDbUsageRecord',
      fields: dirtyFields,
      kilo_user_id,
      requested_model: usageContextInfo.requested_model,
      provider,
    });
  }

  return { core, metadata };
}

export async function logMicrodollarUsage(
  usageStats: MicrodollarUsageStats,
  usageContext: MicrodollarUsageContext
): Promise<{ usageId: string; createdAt: string } | null> {
  usageContext.status_code = usageStats.status_code;
  const contextInfo = extractUsageContextInfo(usageContext);
  const { core, metadata } = await toInsertableDbUsageRecord(usageStats, contextInfo);

  const inserted = await saveUsageRelatedData(
    core,
    metadata,
    usageContext.prior_microdollar_usage,
    usageContext.posthog_distinct_id ?? null
  );

  // `insertUsageRecord` swallows DB errors and returns null; surface that
  // failure to callers so dependent FK writes don't dangle on a row that
  // was never persisted.
  // Use the JS-side identity values we constructed in toInsertableDbUsageRecord
  // rather than the DB-returned ones. The DB round-trip for created_at returns a
  // Postgres timestamp string (e.g. "2026-04-29 01:16:12.945+00") which is not
  // strict ISO 8601 and will fail downstream datetime validators. core.created_at
  // is always new Date().toISOString() so the format is guaranteed.
  return inserted ? { usageId: core.id, createdAt: core.created_at } : null;
}

/**
 * Dispatches the usage write to whichever side of the Atlantic the PostgreSQL
 * primary is on.
 *
 * `kilocode-global-app` executes in both Frankfurt and SFO while the primary is
 * Frankfurt-only. This write holds row locks on `kilocode_users`,
 * `organizations` and `organization_user_usage` across several sequential
 * statements, so from SFO the lock hold is dominated by transatlantic round
 * trips rather than by database work — which is what turns a contended counter
 * row into a queue and, downstream, exhausts the connection pool.
 *
 * Frankfurt instances keep writing directly: a Frankfurt-to-Frankfurt HTTP hop
 * would be pure overhead and a pointless new failure mode.
 */
async function saveUsageRelatedData(
  coreUsageFields: MicrodollarUsage,
  metadataFields: UsageMetaData,
  prior_microdollar_usage: number,
  posthog_distinct_id: string | null
): Promise<UsageRecordInsertResult | null> {
  if (isUSRegion()) {
    const outcome = await recordUsageInPrimaryRegion({
      core: coreUsageFields,
      metadata: metadataFields,
      prior_microdollar_usage,
      posthog_distinct_id,
    });
    // On `unavailable` fall through to the local write. It is slow from here,
    // but a slow billing record beats a lost one. `recordUsageInPrimaryRegion`
    // has already reported the failure.
    if (outcome.kind === 'ok') return outcome.result;
  }

  return saveUsageRelatedDataLocally(
    coreUsageFields,
    metadataFields,
    prior_microdollar_usage,
    posthog_distinct_id
  );
}

/**
 * The write itself, always executed against the primary from wherever it runs.
 * Exported so `POST /api/internal/usage/record` can invoke it in Frankfurt.
 */
export async function saveUsageRelatedDataLocally(
  coreUsageFields: MicrodollarUsage,
  metadataFields: UsageMetaData,
  prior_microdollar_usage: number,
  posthog_distinct_id: string | null
): Promise<UsageRecordWriteOutcome | null> {
  // `isFirst` must be evaluated before the insert — afterwards this record is
  // itself prior usage — but the event it drives is only emitted once the insert
  // has committed. A redelivery that arrives while the first delivery's
  // transaction is still open cannot see the uncommitted row either, so it also
  // computes `isFirst`; emitting here would double-count `first_usage`.
  const isFirst = await isFirstUsage(coreUsageFields, prior_microdollar_usage);
  const inserted = await insertUsageRecord(coreUsageFields, metadataFields);
  if (!inserted) return null;
  if (posthog_distinct_id && !inserted.wasRedelivery) {
    if (isFirst) await sendFirstUsageEvent(coreUsageFields, posthog_distinct_id);
    await sendFirstMicrodollarUsageEventIfNeeded(
      inserted.newMicrodollarsUsed === null
        ? null
        : { newMicrodollarsUsed: inserted.newMicrodollarsUsed },
      coreUsageFields,
      posthog_distinct_id,
      isFirst
    );
  }
  return inserted;
}

async function isFirstUsage(
  usage: MicrodollarUsage,
  prior_microdollar_usage: number
): Promise<boolean> {
  if (prior_microdollar_usage || usage.organization_id) return false;
  //perf: we only pay the costs for querying prior microdollar usage for non-org users that have incurred zero cost so far.
  return !(await db.query.microdollar_usage.findFirst({
    where: eq(microdollar_usage.kilo_user_id, usage.kilo_user_id),
    columns: { created_at: true },
  }));
}

async function sendFirstUsageEvent(usage: MicrodollarUsage, posthog_distinct_id: string) {
  try {
    const userHasPaymentMethod = await hasPaymentMethod(usage.kilo_user_id);
    posthogClient.capture({
      distinctId: posthog_distinct_id,
      event: 'first_usage',
      properties: {
        model: usage.model,
        cost_mUsd: usage.cost,
        has_payment_method: userHasPaymentMethod,
      },
    });
    console.log('first_usage');
  } catch (e) {
    captureException(e, {
      tags: { source: 'posthog_capture' },
      extra: { usage },
    });
  }
}

async function sendFirstMicrodollarUsageEventIfNeeded(
  balanceUpdateResult: BalanceUpdateResult,
  usage: MicrodollarUsage,
  posthog_distinct_id: string,
  isFirst: boolean
) {
  if (!balanceUpdateResult) return;
  const prior_total_usage_at_request_end = Math.abs(
    balanceUpdateResult.newMicrodollarsUsed - usage.cost
  );
  if (prior_total_usage_at_request_end >= 1) return; //already sent event.

  try {
    // TODO: Once available on the user entity, remove extra db query
    const userHasPaymentMethod = await hasPaymentMethod(usage.kilo_user_id);
    posthogClient.capture({
      distinctId: posthog_distinct_id,
      event: 'first_microdollar_usage',
      properties: {
        model: usage.model,
        cost_mUsd: usage.cost,
        has_payment_method: userHasPaymentMethod,
        has_prior_free_usage: !isFirst,
      },
    });
  } catch (e) {
    captureException(e, {
      tags: { source: 'posthog_capture' },
      extra: { usage },
    });
  }
}

/**
 * Creates CTE fragments for upserting a metadata value into a lookup table.
 *
 * Returns CTEs: `{name}_value`, `{name}_existing`, `{name}_ins`, `{name}_cte`
 * The final `{name}_cte` contains the ID of the (possibly newly inserted) row.
 *
 * Uses `WHERE NOT EXISTS` to skip the INSERT when the value already exists,
 * avoiding WAL writes in the common case. The `ON CONFLICT DO UPDATE` handles
 * rare concurrent insert races where two transactions both see no existing row
 * (due to CTE snapshot semantics) and both attempt to insert.
 */
const createUpsertCTE = (metaDataKindName: SQL, value: string | null): SQL => sql`
${metaDataKindName}_value AS (
  SELECT value
  FROM (VALUES (${value})) v(value)
  WHERE value IS NOT NULL
),
${metaDataKindName}_existing AS (
  SELECT ${metaDataKindName}_id
  FROM ${metaDataKindName}, ${metaDataKindName}_value
  WHERE ${metaDataKindName}.${metaDataKindName} = ${metaDataKindName}_value.value
),
${metaDataKindName}_ins AS (
  INSERT INTO ${metaDataKindName} (${metaDataKindName})
  SELECT ${metaDataKindName}_value.value FROM ${metaDataKindName}_value
  WHERE NOT EXISTS (SELECT 1 FROM ${metaDataKindName}_existing)
  ON CONFLICT (${metaDataKindName}) DO UPDATE SET ${metaDataKindName} = EXCLUDED.${metaDataKindName}
  RETURNING ${metaDataKindName}_id
),
${metaDataKindName}_cte AS (
  SELECT ${metaDataKindName}_id FROM ${metaDataKindName}_existing
  UNION ALL
  SELECT ${metaDataKindName}_id FROM ${metaDataKindName}_ins
)`;

type UsageStatementExecutor = Pick<DrizzleTransaction, 'execute'>;

type UsageStatementResult = UsageRecordInsertResult & {
  kiloPassThreshold: number | null;
  organizationUsage?: OrganizationUsageMutationResult;
};

type UsageTransactionResult = {
  inserted: UsageStatementResult;
};

export const USAGE_TRANSACTION_IDLE_TIMEOUT_MS = 60_000;

export function usageTransactionIdleTimeoutQuery(): SQL {
  return sql`
    SELECT pg_catalog.set_config(
      'idle_in_transaction_session_timeout',
      ${`${USAGE_TRANSACTION_IDLE_TIMEOUT_MS}ms`},
      true
    )
  `;
}

export async function setUsageTransactionIdleTimeout(tx: UsageStatementExecutor): Promise<void> {
  // This only bounds idle time between statements while the transaction is open.
  await tx.execute(usageTransactionIdleTimeoutQuery());
}

async function insertUsageTransaction(
  coreUsageFields: MicrodollarUsage,
  metadataFields: UsageMetaData
): Promise<UsageTransactionResult> {
  return db.transaction(async tx => {
    await setUsageTransactionIdleTimeout(tx);
    const inserted = await insertUsageAndMetadataWithBalanceUpdate(
      tx,
      coreUsageFields,
      metadataFields
    );
    if (coreUsageFields.organization_id) {
      if (coreUsageFields.cost > 0) {
        const consumption = await recordOrganizationConsumption(tx, {
          organizationId: coreUsageFields.organization_id,
          kiloUserId: coreUsageFields.kilo_user_id,
          amountMicrodollars: coreUsageFields.cost,
          occurredAt: coreUsageFields.created_at,
          source: 'ai-gateway',
          sourceId: coreUsageFields.id,
        });
        inserted.organizationUsage = consumption.organizationUsage;
      } else if (coreUsageFields.cost < 0) {
        inserted.organizationUsage = await mutateOrganizationUsage(tx, coreUsageFields);
      }
    }
    if (coreUsageFields.cost !== 0) {
      await enqueueDailyUsageRollupRepair(tx, {
        usageId: coreUsageFields.id,
        kiloUserId: coreUsageFields.kilo_user_id,
        organizationId: coreUsageFields.organization_id,
        createdAt: coreUsageFields.created_at,
      });
    }
    return { inserted };
  });
}

function getPostgresErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  if ('code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
    return error.code;
  }
  return 'cause' in error ? getPostgresErrorCode(error.cause) : null;
}

function reportPostCommitFailure(
  message: string,
  error: unknown,
  tags: Record<string, string>,
  usageId: string
): void {
  const databaseErrorCode = getPostgresErrorCode(error);
  console.error(message, { databaseErrorCode });
  captureException(new Error(message), {
    tags,
    extra: { usageId, databaseErrorCode },
  });
}

function organizationUsageMutationTask(
  usage: MicrodollarUsage,
  result: UsageStatementResult
): BestEffortPostCommitTask | null {
  const organizationId = usage.organization_id;
  const organizationUsage = result.organizationUsage;
  if (!organizationId || !organizationUsage) return null;

  return {
    run: async () => scheduleOrganizationLowBalanceAlert(organizationId, organizationUsage),
    reportError: error => {
      reportPostCommitFailure(
        'post-commit organization usage mutation failed',
        error,
        { source: 'postCommitOrganizationUsageMutation' },
        usage.id
      );
    },
  };
}

async function runPostCommitUsageWork(
  usage: MicrodollarUsage,
  result: UsageStatementResult
): Promise<void> {
  const tasks = [organizationUsageMutationTask(usage, result)].filter(task => task !== null);
  await runBestEffortPostCommitTasks(tasks);
}

function scheduleKiloPassBonusIfNeeded(
  usage: MicrodollarUsage,
  result: UsageStatementResult
): void {
  if (result.newMicrodollarsUsed === null) return;
  const effectiveKiloPassThreshold = getEffectiveKiloPassThreshold(result.kiloPassThreshold);
  if (
    effectiveKiloPassThreshold === null ||
    result.newMicrodollarsUsed < effectiveKiloPassThreshold
  ) {
    return;
  }

  void maybeIssueKiloPassBonusFromUsageThreshold({
    kiloUserId: usage.kilo_user_id,
    nowIso: usage.created_at,
  }).catch(async error => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await appendKiloPassAuditLog(db, {
      action: KiloPassAuditLogAction.BonusCreditsIssued,
      result: KiloPassAuditLogResult.Failed,
      kiloUserId: usage.kilo_user_id,
      payload: {
        source: 'usage_threshold',
        error: errorMessage,
      },
    });
  });
}

/**
 * Identity of an already-persisted usage row, or null if it is not there.
 *
 * The same record can still reach this write twice. `recordUsageInPrimaryRegion`
 * no longer retries an attempt timeout — doing so was the dominant source of
 * collisions — but on timeout it falls back to writing locally with the same
 * `core.id` while the remote delivery may still be committing. The losing
 * transaction then collides on the `microdollar_usage` primary key and rolls back
 * in full, so the usage is billed exactly once. Reporting that as a failure would
 * make callers treat billed usage as unrecorded and skip dependent writes.
 *
 * The row's presence under this user is the proof, not the PostgreSQL error code:
 * `id` is generated per delivery by `toInsertableDbUsageRecord`, and the row can
 * only be visible if a delivery of this exact record committed its whole
 * transaction. A deadlock victim that is retried into the collision therefore
 * recovers the same way a plain primary-key violation does.
 *
 * `newMicrodollarsUsed` is not reconstructable here and is only consumed by
 * best-effort PostHog attribution and the Kilo Pass threshold, both of which run
 * on the delivery that committed.
 */
async function findAlreadyRecordedUsage(
  coreUsageFields: MicrodollarUsage
): Promise<UsageRecordWriteOutcome | null> {
  const existing = await db
    .select({ id: microdollar_usage.id })
    .from(microdollar_usage)
    .where(
      and(
        eq(microdollar_usage.id, coreUsageFields.id),
        eq(microdollar_usage.kilo_user_id, coreUsageFields.kilo_user_id)
      )
    )
    .limit(1);
  if (existing.length === 0) return null;

  // Report the JS-side identity, not the DB-returned timestamp: PostgreSQL
  // renders `created_at` as "2026-04-29 01:16:12.945+00", which is not strict
  // ISO 8601 and fails downstream datetime validators.
  return {
    usageId: coreUsageFields.id,
    createdAt: coreUsageFields.created_at,
    newMicrodollarsUsed: null,
    wasRedelivery: true,
  };
}

export async function insertUsageRecord(
  coreUsageFields: MicrodollarUsage,
  metadataFields: UsageMetaData
): Promise<UsageRecordWriteOutcome | null> {
  try {
    const result = await startSpan(
      {
        name: 'db.insert_microdollar_usage_and_update_balance',
        op: 'db.query',
      },
      async () => {
        let attempt = 0;
        while (true) {
          try {
            // This can fail if new deduplicated values are inserted simultaneously.
            // Every retry opens a fresh transaction for the usage and balance write.
            return await insertUsageTransaction(coreUsageFields, metadataFields);
          } catch (error) {
            // A collision on this record's own id can never be resolved by
            // retrying — `id` is fixed for the delivery — so stop immediately and
            // let the outer handler recover the committed row's identity. Retrying
            // it burned three attempts and rebuilt the statement each time.
            if (attempt >= 2 || isUsageRowConflict(error)) throw error;
            // Never log the raw error: its message is the interpolated statement,
            // roughly 30KB including prompt prefixes and the client IP.
            sentryLogger('insertUsageRecord', 'warning')('insertUsageRecord concurrency failure', {
              usageId: coreUsageFields.id,
              attempt,
              error: describeDatabaseError(error),
            });
            await new Promise(r => setTimeout(r, Math.random() * 100));
            attempt++;
          }
        }
      }
    );

    await runPostCommitUsageWork(coreUsageFields, result.inserted);
    scheduleKiloPassBonusIfNeeded(coreUsageFields, result.inserted);
    return {
      usageId: result.inserted.usageId,
      createdAt: result.inserted.createdAt,
      newMicrodollarsUsed: result.inserted.newMicrodollarsUsed,
      wasRedelivery: false,
    };
  } catch (error) {
    // The lookup itself is best-effort: it must never mask the original failure,
    // and it throws for a malformed `id`, which is a genuine failed write.
    const alreadyRecorded = await findAlreadyRecordedUsage(coreUsageFields).catch(() => null);
    if (alreadyRecorded) {
      // Not an exception: this is the designed outcome of a redelivered write.
      sentryLogger('insertUsageRecord', 'warning')(
        'insertUsageRecord received a redelivery of an already-recorded usage id',
        { usageId: coreUsageFields.id }
      );
      return alreadyRecorded;
    }
    // Report the redacted description rather than `error`, whose message carries
    // the interpolated statement and its parameters. Only the original stack's
    // frames are carried over: `error.stack` begins with `name: message`, so
    // copying it verbatim would put the message straight back into the event.
    const described = describeDatabaseError(error);
    console.error('insertUsageRecord failed', { usageId: coreUsageFields.id, error: described });
    const summary = `insertUsageRecord failed (code=${described.code ?? 'unknown'} constraint=${described.constraint ?? 'none'})`;
    const redacted = new Error(summary);
    redacted.stack = stackFramesUnderHeader(error, `Error: ${summary}`);
    captureException(redacted, {
      tags: {
        source: 'insertUsageRecord',
        spendCategory: 'variable',
        spendSource: 'ai_gateway',
        ownerType: coreUsageFields.organization_id ? 'organization' : 'user',
        databaseErrorCode: described.code ?? 'unknown',
      },
      extra: { sourceRecordId: coreUsageFields.id, databaseError: described },
    });
    return null;
  }
}

async function insertUsageAndMetadataWithBalanceUpdate(
  executor: UsageStatementExecutor,
  coreUsageFields: MicrodollarUsage,
  metadataFields: UsageMetaData
): Promise<UsageStatementResult> {
  // Use a single SQL statement with CTEs to insert usage, upsert all lookup values, metadata, and update user balance in one roundtrip.
  // The contended daily rollup is deliberately maintained after this transaction commits.
  // This ensures atomicity: microdollar_usage insert and kilocode_users.microdollars_used update happen together
  const result = await executor.execute<{
    usage_id: string;
    usage_created_at: string;
    new_microdollars_used: number | null;
    kilo_pass_threshold: number | null;
  }>(sql`
          WITH microdollar_usage_ins AS (
            INSERT INTO microdollar_usage (
              id, kilo_user_id, organization_id, provider, cost,
              input_tokens, output_tokens, cache_write_tokens, cache_hit_tokens,
              created_at, model, requested_model, cache_discount, has_error, abuse_classification,
              inference_provider, project_id
            ) VALUES (
              ${coreUsageFields.id},
              ${coreUsageFields.kilo_user_id},
              ${coreUsageFields.organization_id},
              ${coreUsageFields.provider},
              ${coreUsageFields.cost},
              ${coreUsageFields.input_tokens},
              ${coreUsageFields.output_tokens},
              ${coreUsageFields.cache_write_tokens},
              ${coreUsageFields.cache_hit_tokens},
              ${coreUsageFields.created_at},
              ${coreUsageFields.model},
              ${coreUsageFields.requested_model},
              ${coreUsageFields.cache_discount},
              ${coreUsageFields.has_error},
              ${coreUsageFields.abuse_classification},
              ${coreUsageFields.inference_provider},
              ${coreUsageFields.project_id}
            )
            RETURNING id, created_at
          )
          , ${createUpsertCTE(sql`http_user_agent`, metadataFields.http_user_agent)}
          , ${createUpsertCTE(sql`http_ip`, metadataFields.http_x_forwarded_for)}
          , ${createUpsertCTE(sql`vercel_ip_country`, metadataFields.http_x_vercel_ip_country)}
          , ${createUpsertCTE(sql`vercel_ip_city`, metadataFields.http_x_vercel_ip_city)}
          , ${createUpsertCTE(sql`ja4_digest`, metadataFields.http_x_vercel_ja4_digest)}
          , ${createUpsertCTE(sql`system_prompt_prefix`, metadataFields.system_prompt_prefix)}
          , ${createUpsertCTE(sql`finish_reason`, metadataFields.finish_reason)}
          , ${createUpsertCTE(sql`editor_name`, metadataFields.editor_name)}
          , ${createUpsertCTE(sql`api_kind`, metadataFields.api_kind)}
          , ${createUpsertCTE(sql`feature`, metadataFields.feature)}
          , ${createUpsertCTE(sql`mode`, metadataFields.mode)}
          , ${createUpsertCTE(sql`auto_model`, metadataFields.auto_model)}
          , metadata_ins AS (
            INSERT INTO microdollar_usage_metadata (
              id,
              message_id,
              created_at,
              user_prompt_prefix,
              vercel_ip_latitude,
              vercel_ip_longitude,
              system_prompt_length,
              max_tokens,
              has_middle_out_transform,
              status_code,
              upstream_id,
              latency,
              moderation_latency,
              generation_time,
              is_byok,
              is_user_byok,
              streamed,
              cancelled,
              has_tools,
              machine_id,
              session_id,
              market_cost,
              is_free,
              abuse_delay,
              abuse_downgraded_from,

              http_user_agent_id,
              http_ip_id,
              vercel_ip_country_id,
              vercel_ip_city_id,
              ja4_digest_id,
              system_prompt_prefix_id,
              finish_reason_id,
              editor_name_id,
              api_kind_id,
              feature_id,
              mode_id,
              auto_model_id
            )
            SELECT
              ${metadataFields.id},
              ${metadataFields.message_id ?? '<missing>'},
              ${metadataFields.created_at},
              ${metadataFields.user_prompt_prefix},
              ${metadataFields.http_x_vercel_ip_latitude},
              ${metadataFields.http_x_vercel_ip_longitude},
              ${metadataFields.system_prompt_length},
              ${metadataFields.max_tokens},
              ${metadataFields.has_middle_out_transform},
              ${metadataFields.status_code},
              ${metadataFields.upstream_id},
              ${metadataFields.latency},
              ${metadataFields.moderation_latency},
              ${metadataFields.generation_time},
              ${metadataFields.is_byok},
              ${metadataFields.is_user_byok},
              ${metadataFields.streamed},
              ${metadataFields.cancelled},
              ${metadataFields.has_tools},
              ${metadataFields.machine_id},
              ${metadataFields.session_id},
              ${metadataFields.market_cost},
              ${metadataFields.is_free},
              ${metadataFields.abuse_delay},
              ${metadataFields.abuse_downgraded_from},

              (SELECT http_user_agent_id FROM http_user_agent_cte),
              (SELECT http_ip_id FROM http_ip_cte),
              (SELECT vercel_ip_country_id FROM vercel_ip_country_cte),
              (SELECT vercel_ip_city_id FROM vercel_ip_city_cte),
              (SELECT ja4_digest_id FROM ja4_digest_cte),
              (SELECT system_prompt_prefix_id FROM system_prompt_prefix_cte),
              (SELECT finish_reason_id FROM finish_reason_cte),
              (SELECT editor_name_id FROM editor_name_cte),
              (SELECT api_kind_id FROM api_kind_cte),
              (SELECT feature_id FROM feature_cte),
              (SELECT mode_id FROM mode_cte),
              (SELECT auto_model_id FROM auto_model_cte)
          )
          , balance_update AS (
            UPDATE kilocode_users
            SET microdollars_used = microdollars_used + ${coreUsageFields.cost}
            WHERE id = ${coreUsageFields.kilo_user_id}
              AND ${coreUsageFields.organization_id}::uuid IS NULL
              AND ${coreUsageFields.cost} > 0
            RETURNING microdollars_used AS new_microdollars_used, kilo_pass_threshold
          )
          SELECT
            microdollar_usage_ins.id AS usage_id,
            microdollar_usage_ins.created_at AS usage_created_at,
            balance_update.new_microdollars_used,
            balance_update.kilo_pass_threshold
          FROM microdollar_usage_ins
          LEFT JOIN balance_update ON true
        `);

  const inserted = result.rows[0];
  if (!inserted) {
    throw new Error('microdollar_usage insert returned no identity');
  }

  // Missing balance update is expected for org usage and zero-cost rows, but
  // suspicious for positive-cost personal usage.
  if (
    inserted.new_microdollars_used === null &&
    !coreUsageFields.organization_id &&
    coreUsageFields.cost > 0
  ) {
    captureMessage('impossible: missing user', {
      level: 'fatal',
      tags: { source: 'insertUsageAndUpdateBalance' },
      extra: { coreUsageFields },
    });
  }

  const newMicrodollarsUsed =
    inserted.new_microdollars_used === null ? null : Number(inserted.new_microdollars_used);

  const kiloPassThreshold =
    inserted.kilo_pass_threshold == null ? null : Number(inserted.kilo_pass_threshold);

  return {
    usageId: inserted.usage_id,
    createdAt: inserted.usage_created_at,
    newMicrodollarsUsed,
    kiloPassThreshold,
  };
}

export function countAndStoreUsage(
  clonedReponse: Response,
  usageContext: MicrodollarUsageContext,
  openrouterRequestSpan: Span | undefined
) {
  let usageStatsPromise: Promise<MicrodollarUsageStats | null> = Promise.resolve(null);

  const parseResponseText = async (
    parse: (content: string) => MicrodollarUsageStats
  ): Promise<MicrodollarUsageStats | null> => {
    try {
      return parse(await clonedReponse.text());
    } catch (error) {
      if (isResponseInterruptedError(error)) return null;
      throw error;
    }
  };

  if (clonedReponse.body) {
    if (usageContext.api_kind === 'responses') {
      usageStatsPromise = usageContext.isStreaming
        ? parseResponsesMicrodollarUsageFromStream(
            clonedReponse.body,
            usageContext.kiloUserId,
            openrouterRequestSpan,
            usageContext.provider,
            clonedReponse.status
          )
        : parseResponseText(content =>
            parseResponsesMicrodollarUsageFromString(content, clonedReponse.status)
          );
    }
    if (usageContext.api_kind === 'chat_completions') {
      usageStatsPromise = usageContext.isStreaming
        ? parseMicrodollarUsageFromStream(
            clonedReponse.body,
            usageContext.kiloUserId,
            openrouterRequestSpan,
            usageContext.provider,
            clonedReponse.status
          )
        : parseResponseText(content =>
            parseMicrodollarUsageFromString(content, usageContext.kiloUserId, clonedReponse.status)
          );
    }
    if (usageContext.api_kind === 'messages') {
      usageStatsPromise = usageContext.isStreaming
        ? parseMessagesMicrodollarUsageFromStream(
            clonedReponse.body,
            usageContext.kiloUserId,
            openrouterRequestSpan,
            usageContext.provider,
            clonedReponse.status
          )
        : parseResponseText(content =>
            parseMessagesMicrodollarUsageFromString(content, clonedReponse.status)
          );
    }
  }

  return usageStatsPromise.then(usageStats => processTokenData(usageStats, usageContext));
}

export function processOpenRouterUsage(
  usage: OpenRouterUsage | null | undefined,
  coreProps: NotYetCostedUsageStats,
  vercelProviderMetadata?: VercelProviderMetaData | null
): JustTheCostsUsageStats {
  // usage may be null when there's no response (e.g. error), so default to empty object
  const { cost_mUsd, is_byok } = computeOpenRouterCostFields(
    usage ?? {},
    coreProps,
    'sse_processing'
  );

  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    cacheHitTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens:
      usage?.prompt_tokens_details?.cache_write_tokens ??
      usage?.prompt_tokens_details?.cache_creation_input_tokens ??
      0,
    outputTokens: usage?.completion_tokens ?? 0,
    cost_mUsd,
    is_byok: is_byok ?? extractVercelIsByok(vercelProviderMetadata?.gateway),
  };
}

export async function parseMicrodollarUsageFromStream(
  stream: ReadableStream,
  kiloUserId: string,
  openrouterRequestSpan: Span | undefined,
  provider: ProviderId,
  statusCode: number
): Promise<MicrodollarUsageStats> {
  // End the request span immediately as this function starts
  openrouterRequestSpan?.end();
  const streamProcessingSpan = startInactiveSpan({
    name: 'openrouter-stream-processing',
    op: 'performance',
  });
  const timeToFirstTokenSpan = startInactiveSpan({
    name: 'time-to-first-token',
    op: 'performance',
  });

  let messageId: string | null = null;
  let model: string | null = null;
  let responseContent = ''; // for abuse investigation
  let reportedError = statusCode >= 400;
  let effectiveStatusCode = statusCode;
  const startedAt = performance.now();
  let firstTokenReceived = false;
  let usage: OpenRouterUsage | null = null;
  let inference_provider: string | null = null;
  let finish_reason: string | null = null;
  let vercelProviderMetadata: VercelProviderMetaData | null = null;

  const sseStreamParser = createParser({
    onEvent(event: EventSourceMessage) {
      if (!firstTokenReceived) {
        sentryRootSpan()?.setAttribute(
          'openrouter.time_to_first_token_ms',
          performance.now() - startedAt
        );
        firstTokenReceived = true;
        timeToFirstTokenSpan.end();
      }

      if (event.data === '[DONE]') {
        return;
      }

      const json: ChatCompletionChunk = JSON.parse(event.data);

      if (!json) {
        captureException(new Error('SUSPICIOUS: No JSON in SSE event'), {
          extra: { event },
        });
        return;
      }

      if ('error' in json) {
        const error = json.error as OpenRouterError;
        reportedError = true;
        if (typeof error.code === 'number') {
          effectiveStatusCode = error.code;
        }
        captureException(new Error(`OpenRouter error: ${error.message}`), {
          tags: { source: 'sse_processing' },
          extra: { json, event },
        });
      }

      model = json.model ?? model;
      messageId = json.id ?? messageId;
      usage = json.usage ?? usage;
      const choice = json.choices?.[0];
      const chunkProviderMetadata = choice?.delta?.provider_metadata;
      if (chunkProviderMetadata) {
        vercelProviderMetadata = chunkProviderMetadata;
      }
      inference_provider =
        json.provider ??
        chunkProviderMetadata?.gateway?.routing?.finalProvider ??
        inference_provider;
      finish_reason = choice?.finish_reason ?? finish_reason;

      const contentDelta = choice?.delta?.content;
      if (contentDelta) {
        responseContent += contentDelta;
      }
    },
  });

  const wasAborted = await drainSseStream(
    stream,
    chunk => sseStreamParser.feed(chunk),
    streamProcessingSpan
  );

  if (!reportedError && !usage) {
    captureMessage('SUSPICIOUS: No usage chunk in stream', {
      level: 'warning',
      tags: { source: 'usage_processing' },
      extra: { kiloUserId, provider, messageId, model },
    });
  }

  const coreProps = {
    kiloUserId,
    messageId,
    hasError: reportedError || wasAborted || isErrorFinishReason(finish_reason),
    model,
    responseContent,
    inference_provider,
    finish_reason,
    upstream_id: extractVercelUpstreamId(vercelProviderMetadata),
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: true,
    cancelled: null,
    status_code: effectiveStatusCode,
  };

  const costs = processOpenRouterUsage(usage, coreProps, vercelProviderMetadata);

  return { ...coreProps, ...costs };
}

export function parseMicrodollarUsageFromString(
  fullResponse: string,
  kiloUserId: string,
  statusCode: number
): MicrodollarUsageStats {
  const responseJson = JSON.parse(fullResponse) as
    | (OpenAI.Chat.Completions.ChatCompletion &
        MaybeHasOpenRouterUsage &
        MaybeHasVercelProviderMetaData)
    | null;

  if (responseJson?.usage?.is_byok == null && responseJson?.usage?.cost) {
    captureException(new Error('SUSPICIOUS: is_byok is null'), {
      tags: { source: 'string_processing' },
      extra: { responseJson },
    });
  }
  const choice = responseJson?.choices?.[0];
  const finish_reason = choice?.finish_reason ?? null;
  const vercelProviderMetadata = choice?.message?.provider_metadata ?? null;
  const coreProps = {
    kiloUserId,
    messageId: responseJson?.id ?? null,
    hasError: !responseJson?.model || statusCode >= 400 || isErrorFinishReason(finish_reason),
    model: responseJson?.model ?? null,
    responseContent: choice?.message.content ?? '',
    inference_provider:
      responseJson?.provider ?? vercelProviderMetadata?.gateway?.routing?.finalProvider ?? null,
    upstream_id: extractVercelUpstreamId(vercelProviderMetadata),
    finish_reason,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: false,
    cancelled: null,
    status_code: statusCode,
  };

  const costs = processOpenRouterUsage(responseJson?.usage, coreProps, vercelProviderMetadata);

  return { ...coreProps, ...costs };
}

export function calculateKiloExclusiveCost_mUsd(
  model: KiloExclusiveModel,
  usage: JustTheCostsUsageStats
): number | undefined {
  const pricing = model?.pricing;
  if (!pricing) {
    return 0;
  }
  if (pricing.fallbackOnly && usage.cost_mUsd > 0) {
    return undefined;
  }
  const uncachedInputTokens = usage.inputTokens - usage.cacheHitTokens - usage.cacheWriteTokens;
  if (uncachedInputTokens < 0) {
    captureMessage('SUSPICIOUS: negative uncached input tokens', {
      level: 'error',
      tags: { source: 'usage_processing' },
      extra: { model: model.public_id, usage },
    });
  }
  return Math.round(
    calculateCost_mUsd(
      {
        uncachedInputTokens: uncachedInputTokens >= 0 ? uncachedInputTokens : usage.inputTokens,
        totalOutputTokens: usage.outputTokens,
        cacheHitTokens: usage.cacheHitTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
      pricing.tiers
    )
  );
}

export async function processTokenData(
  usageStats: MicrodollarUsageStats | null,
  usageContext: MicrodollarUsageContext
): Promise<{ usageId: string; createdAt: string } | null> {
  if (!usageStats) {
    captureMessage('SUSPICIOUS: No usage information', {
      level: 'error',
      tags: { source: 'usage_processing' },
      extra: { usageContext },
    });
    return null;
  }

  const timer = createTimer();
  const generationProvider = await getGenerationLookupProvider(usageStats, usageContext);
  const generation =
    generationProvider &&
    usageStats.messageId &&
    (await fetchGeneration(usageStats.messageId, generationProvider));
  if (usageStats.messageId) {
    timer.log(`fetch generation for message ${usageStats.messageId}`);
  }
  if (generation) {
    const genStats = mapToUsageStats(
      generation,
      usageStats.responseContent,
      usageContext.kiloUserId,
      usageContext.provider
    );

    if (usageContext.provider === 'vercel' && usageStats.inputTokens > 0) {
      // It seems Vercel's /generation result does not include cache hit tokens in input tokens, unlike OpenRouter.
      // Since it's not completely clear this is the case and in the past the numbers were inconsistent
      // we keep the response usage data if we have it.
      genStats.inputTokens = usageStats.inputTokens;
      genStats.outputTokens = usageStats.outputTokens;
      genStats.cacheHitTokens = usageStats.cacheHitTokens;
      genStats.cacheWriteTokens = usageStats.cacheWriteTokens;
    }

    genStats.model = usageStats.model; // openrouter bug?
    genStats.upstream_id ??= usageStats.upstream_id; // keep the id the response already reported
    genStats.hasError = usageStats.hasError; // retain by choice
    genStats.status_code = usageStats.status_code; // retain by choice
    genStats.streamed ??= usageContext.isStreaming;
    if (genStats.cost_mUsd !== usageStats.cost_mUsd) {
      // The provider's generation lookup and the response's own usage payload should
      // yield the same cost. A mismatch means inconsistent token or pricing data from
      // the provider; the generation lookup values win (see assignment below).
      console.warn(
        'Cost from provider generation lookup differs from cost computed from response usage data:',
        {
          model: genStats.model,
          cost_mUsd: { generation: genStats.cost_mUsd, response: usageStats.cost_mUsd },
          cacheDiscount_mUsd: {
            generation: genStats.cacheDiscount_mUsd,
            response: usageStats.cacheDiscount_mUsd,
          },
        }
      );
    }
    usageStats = genStats;
  }

  if (
    !usageStats.model || // fallback for failure cases
    shouldRedactModelNameInMicrodollarUsage(usageContext.provider, usageContext.requested_model)
  ) {
    usageStats.model = usageContext.requested_model;
  }

  const kiloExclusiveModel = findKiloExclusiveModel(usageContext.requested_model);
  if (kiloExclusiveModel?.pricing) {
    const exclusiveCost_mUsd = calculateKiloExclusiveCost_mUsd(kiloExclusiveModel, usageStats);
    if (exclusiveCost_mUsd !== undefined) {
      usageStats.market_cost = usageStats.cost_mUsd;
      usageStats.cost_mUsd = exclusiveCost_mUsd;
    }
  }

  const customCost_mUsd = calculateCustomCost_mUsd(usageContext.requested_model, usageStats);

  // Report upstream cost to abuse service BEFORE zeroing for free/BYOK
  // (abuse service needs actual spend for heuristics like free_tier_exhausted)
  reportAbuseCost(usageContext, usageStats).catch(error => {
    console.error('[Abuse] Failed to report cost:', error);
  });

  // Preserve the real cost before zeroing for free/BYOK
  usageStats.market_cost ??= usageStats.cost_mUsd;
  usageStats.cost_mUsd = customCost_mUsd ?? usageStats.cost_mUsd;

  if ((await isFreeModel(usageContext.requested_model)) || usageContext.user_byok) {
    usageStats.cost_mUsd = 0;
    usageStats.cacheDiscount_mUsd = 0;
  }

  return logMicrodollarUsage(usageStats, usageContext);
}

async function getGenerationLookupProvider(
  usageStats: MicrodollarUsageStats | null,
  usageContext: MicrodollarUsageContext
): Promise<typeof OPENROUTER | typeof VERCEL_AI_GATEWAY | undefined> {
  const provider =
    usageContext.provider === 'openrouter'
      ? OPENROUTER
      : usageContext.provider === 'vercel'
        ? VERCEL_AI_GATEWAY
        : undefined;
  const isSuccessStatusCode = (usageStats?.status_code ?? 200) < 400;
  if (!provider || !isSuccessStatusCode) {
    return undefined;
  }
  const hasOutputTokens = (usageStats?.outputTokens ?? 0) > 0;
  const hasCostWhenPaid =
    (await isFreeModel(usageContext.requested_model)) ||
    usageContext.user_byok ||
    (usageStats?.cost_mUsd ?? 0) > 0;
  const hasInferenceProvider = Boolean(usageStats?.inference_provider);
  if (!hasOutputTokens) {
    console.debug('[getGenerationLookupProvider] token stats are missing');
    return provider;
  }
  if (!hasCostWhenPaid) {
    console.debug('[getGenerationLookupProvider] cost is missing');
    return provider;
  }
  if (!hasInferenceProvider) {
    console.debug('[getGenerationLookupProvider] inference provider is missing');
    return provider;
  }
  return undefined;
}

export const mapToUsageStats = (
  { data }: OpenRouterGeneration,
  responseContent: string,
  kiloUserId: string,
  provider: ProviderId
): MicrodollarUsageStats => {
  let llmCostUsd;
  if (!data.is_byok) {
    llmCostUsd = data.total_cost;
  } else if (data.upstream_inference_cost == undefined) {
    captureMessage('SUSPICIOUS: openrouter missing upstream_inference_cost', {
      level: 'error',
      tags: { source: 'openrouter-generation-processing' },
      extra: { ...data, kiloUserId },
    });
    llmCostUsd = data.total_cost * OPENROUTER_BYOK_COST_MULTIPLIER; // this is the cost we charge for BYOK, so we multiply by 20 to get the actual cost
    // openrouter bug, see
  } else {
    llmCostUsd = data.upstream_inference_cost;
  }

  return {
    messageId: data.id,
    hasError: false,
    model: data.model,
    responseContent,
    inputTokens:
      provider === 'vercel'
        ? (data.native_tokens_prompt ?? 0) +
          (data.native_tokens_cached ?? 0) +
          (data.native_tokens_cache_creation ?? 0)
        : (data.native_tokens_prompt ?? 0),
    cacheHitTokens: data.native_tokens_cached ?? 0,
    cacheWriteTokens: data.native_tokens_cache_creation ?? 0,
    outputTokens:
      provider === 'vercel'
        ? (data.native_tokens_completion ?? 0) + (data.native_tokens_reasoning ?? 0)
        : (data.native_tokens_completion ?? 0),
    cost_mUsd: toMicrodollars(llmCostUsd),
    is_byok: data.is_byok ?? null,
    cacheDiscount_mUsd:
      data.cache_discount == undefined ? undefined : toMicrodollars(data.cache_discount),
    inference_provider: data.provider_name ?? null,
    upstream_id: data.upstream_id ?? null,
    finish_reason: data.finish_reason ?? null,
    latency: data.latency ?? null,
    moderation_latency: data.moderation_latency ?? null,
    generation_time: data.generation_time ?? null,
    streamed: data.streamed ?? null,
    cancelled: data.cancelled ?? null,
    status_code: 200,
  };
};

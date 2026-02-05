import { randomUUID } from 'crypto';
import { db } from './drizzle';
import type { MicrodollarUsage, Organization } from '@/db/schema';
import { microdollar_usage } from '@/db/schema';
import { createTimer } from '@/lib/timer';
import type { OpenAI } from 'openai';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import type {
  OpenRouterChatCompletionRequest,
  OpenRouterGeneration,
} from './providers/openrouter/types';
import { fetchGeneration, PROVIDERS } from './providers';
import type { FraudDetectionHeaders } from './utils';
import { toMicrodollars } from './utils';
import { captureException, captureMessage, startSpan, startInactiveSpan } from '@sentry/nextjs';
import type { Span } from '@sentry/nextjs';
import PostHogClient from '@/lib/posthog';
import { hasPaymentMethod } from '@/lib/admin-utils-serverside';
import type { SQL } from 'drizzle-orm';
import { eq, sql } from 'drizzle-orm';
import { sentryRootSpan } from './getRootSpan';
import { ingestOrganizationTokenUsage } from '@/lib/organizations/organization-usage';
import type { ProviderId } from '@/lib/providers/provider-id';
import { isFreeModel, isStealthModelOnKiloCodeOnly } from '@/lib/models';
import { sentryLogger } from '@/lib/utils.server';
import { maybeIssueKiloPassBonusFromUsageThreshold } from '@/lib/kilo-pass/usage-triggered-bonus';
import { getEffectiveKiloPassThreshold } from '@/lib/kilo-pass/threshold';
import { appendKiloPassAuditLog } from '@/lib/kilo-pass/issuance';
import { KiloPassAuditLogAction, KiloPassAuditLogResult } from '@/lib/kilo-pass/enums';
import { reportAbuseCost } from '@/lib/abuse-service';

const posthogClient = PostHogClient();

type OpenRouterUsage = {
  cost?: number;
  is_byok?: boolean | null;
  cost_details: { upstream_inference_cost: number };
  completion_tokens: number;
  completion_tokens_details: { reasoning_tokens: number };
  prompt_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
  total_tokens: number;
}; //ref: https://openrouter.ai/docs/use-cases/usage-accounting#response-format

type VercelProviderMetaData = { gateway?: { routing?: { resolvedProvider?: string } } };

type MaybeHasVercelProviderMetaData = {
  choices?: {
    message?: {
      provider_metadata?: VercelProviderMetaData;
    };
  }[];
};

type MaybeHasVercelProviderMetaDataChunk = {
  choices?: {
    delta?: { provider_metadata?: VercelProviderMetaData };
  }[];
};

type MaybeHasOpenRouterUsage = {
  usage?: OpenRouterUsage | null;
  provider?: string | null;
};

type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk &
  MaybeHasOpenRouterUsage &
  MaybeHasVercelProviderMetaDataChunk;

// For BYOK (Bring Your Own Key) requests, OpenRouter only reports 5% of the actual cost
// because that's what they charge for the BYOK feature. Although we now use upstream_inference_cost, we still do some sanity checks.
const OPENROUTER_BYOK_COST_MULTIPLIER = 20.0;

export function extractPromptInfo(body: OpenRouterChatCompletionRequest) {
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

interface Message {
  role: string;
  content?: string | { type?: string; text?: string }[];
  parts?: { text?: string }[];
}

const extractMessageTextContent = (m: Message) =>
  typeof m.content === 'string'
    ? m.content
    : Array.isArray(m.content)
      ? m.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n')
      : '';

type NotYetCostedUsageStats = {
  messageId: string | null;
  model: string | null;
  responseContent: string;
  hasError: boolean;
  inference_provider: string | null;
  upstream_id: string | null;
  finish_reason: string | null;
  latency: number | null;
  moderation_latency: number | null;
  generation_time: number | null;
  streamed: boolean | null;
  cancelled: boolean | null;
};

type JustTheCostsUsageStats = {
  cost_mUsd: number;
  cacheDiscount_mUsd?: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheHitTokens: number;
  is_byok: boolean | null;
};

export type MicrodollarUsageStats = NotYetCostedUsageStats & JustTheCostsUsageStats;

export type PromptInfo = {
  system_prompt_prefix: string;
  system_prompt_length: number;
  user_prompt_prefix: string;
};

export type MicrodollarUsageContext = {
  kiloUserId: string;
  fraudHeaders: FraudDetectionHeaders;
  organizationId?: Organization['id'];
  provider: ProviderId;
  requested_model: string;
  promptInfo: PromptInfo;
  max_tokens: number | null;
  has_middle_out_transform: boolean | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  isStreaming: boolean;
  prior_microdollar_usage: number;
  /** User email for authenticated users - used as PostHog distinctId. Undefined for anonymous users. */
  posthog_distinct_id?: string;
  project_id: string | null;
  status_code: number | null;
  editor_name: string | null;
  /** True if user/org is using their own API key - cost should be zeroed out */
  user_byok: boolean;
  has_tools: boolean;
  /** Request ID from abuse service classify response, for cost tracking correlation. 0 means skip. */
  abuse_request_id?: number;
};

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
    is_user_byok: usageContext.user_byok,
    has_tools: usageContext.has_tools,
  };
}

export type CoreUsageWithMetaData = {
  core: MicrodollarUsage;
  metadata: UsageMetaData;
};

export function toInsertableDbUsageRecord(
  usageStats: MicrodollarUsageStats,
  usageContextInfo: UsageContextInfo
): CoreUsageWithMetaData {
  const id = randomUUID();
  const created_at = new Date().toISOString();

  const { kilo_user_id, organization_id, project_id, provider, ...metadataFromContext } =
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
    latency: usageStats.latency,
    moderation_latency: usageStats.moderation_latency,
    generation_time: usageStats.generation_time,
    is_byok: usageStats.is_byok,
    streamed: usageStats.streamed,
    cancelled: usageStats.cancelled,
  };

  // Legacy heuristic classification removed - abuse_classification is now handled
  // by the external abuse detection service in src/lib/abuse-service.ts
  if (organization_id) {
    //never log any sensitive data for orgs
    metadata.user_prompt_prefix = null;
    metadata.system_prompt_prefix = null;
  }

  return { core, metadata };
}

export async function logMicrodollarUsage(
  usageStats: MicrodollarUsageStats,
  usageContext: MicrodollarUsageContext
) {
  const contextInfo = extractUsageContextInfo(usageContext);
  const { core, metadata } = toInsertableDbUsageRecord(usageStats, contextInfo);

  await saveUsageRelatedData(
    core,
    metadata,
    usageContext.prior_microdollar_usage,
    usageContext.posthog_distinct_id ?? null
  );
}

async function saveUsageRelatedData(
  coreUsageFields: MicrodollarUsage,
  metadataFields: UsageMetaData,
  prior_microdollar_usage: number,
  posthog_distinct_id: string | null
) {
  const isFirst = await isFirstUsage(coreUsageFields, prior_microdollar_usage);
  if (isFirst && posthog_distinct_id)
    await sendFirstUsageEvent(coreUsageFields, posthog_distinct_id);
  const balanceUpdateResult = await insertUsageRecord(coreUsageFields, metadataFields);
  if (posthog_distinct_id) {
    await sendFirstMicrodollarUsageEventIfNeeded(
      balanceUpdateResult,
      coreUsageFields,
      posthog_distinct_id,
      isFirst
    );
  }
  await ingestOrganizationTokenUsage(coreUsageFields);
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

type BalanceUpdateResult = { newMicrodollarsUsed: number } | null;

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

export type UsageMetaData = {
  id: string;
  message_id: string;
  created_at: string;
  http_x_forwarded_for: string | null;
  http_x_vercel_ip_city: string | null;
  http_x_vercel_ip_country: string | null;
  http_x_vercel_ip_latitude: number | null;
  http_x_vercel_ip_longitude: number | null;
  http_x_vercel_ja4_digest: string | null;
  user_prompt_prefix: string | null;
  system_prompt_prefix: string | null;
  system_prompt_length: number | null;
  http_user_agent: string | null;
  max_tokens: number | null;
  has_middle_out_transform: boolean | null;
  status_code: number | null;
  upstream_id: string | null;
  finish_reason: string | null;
  latency: number | null;
  moderation_latency: number | null;
  generation_time: number | null;
  is_byok: boolean | null;
  is_user_byok: boolean;
  streamed: boolean | null;
  cancelled: boolean | null;
  editor_name: string | null;
  has_tools: boolean | null;
};

export async function insertUsageRecord(
  coreUsageFields: MicrodollarUsage,
  metadataFields: UsageMetaData
): Promise<BalanceUpdateResult> {
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
            //this can fail if new deduplicated values are inserted simultaneously
            return await insertUsageAndMetadataWithBalanceUpdate(coreUsageFields, metadataFields);
          } catch (error) {
            if (attempt >= 2) throw error;
            sentryLogger('insertUsageRecord', 'warning')(
              'insertUsageRecord concurrency failure',
              error
            );
            await new Promise(r => setTimeout(r, Math.random() * 100));
            attempt++;
          }
        }
      }
    );
    return result;
  } catch (error) {
    console.error('insertUsageRecord failed', error);
    captureException(error, {
      tags: { source: 'insertUsageRecord' },
      extra: { coreUsageFields, metadataFields },
    });
    return null;
  }
}

async function insertUsageAndMetadataWithBalanceUpdate(
  coreUsageFields: MicrodollarUsage,
  metadataFields: UsageMetaData
): Promise<BalanceUpdateResult> {
  // Use a single SQL statement with CTEs to insert usage, upsert all lookup values, metadata, and update user balance in one roundtrip
  // This ensures atomicity: microdollar_usage insert and kilocode_users.microdollars_used update happen together
  const result = await db.execute<{
    new_microdollars_used: number;
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
          )
          , ${createUpsertCTE(sql`http_user_agent`, metadataFields.http_user_agent)}
          , ${createUpsertCTE(sql`http_ip`, metadataFields.http_x_forwarded_for)}
          , ${createUpsertCTE(sql`vercel_ip_country`, metadataFields.http_x_vercel_ip_country)}
          , ${createUpsertCTE(sql`vercel_ip_city`, metadataFields.http_x_vercel_ip_city)}
          , ${createUpsertCTE(sql`ja4_digest`, metadataFields.http_x_vercel_ja4_digest)}
          , ${createUpsertCTE(sql`system_prompt_prefix`, metadataFields.system_prompt_prefix)}
          , ${createUpsertCTE(sql`finish_reason`, metadataFields.finish_reason)}
          , ${createUpsertCTE(sql`editor_name`, metadataFields.editor_name)}
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

              http_user_agent_id,
              http_ip_id,
              vercel_ip_country_id,
              vercel_ip_city_id,
              ja4_digest_id,
              system_prompt_prefix_id,
              finish_reason_id,
              editor_name_id
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

              (SELECT http_user_agent_id FROM http_user_agent_cte),
              (SELECT http_ip_id FROM http_ip_cte),
              (SELECT vercel_ip_country_id FROM vercel_ip_country_cte),
              (SELECT vercel_ip_city_id FROM vercel_ip_city_cte),
              (SELECT ja4_digest_id FROM ja4_digest_cte),
              (SELECT system_prompt_prefix_id FROM system_prompt_prefix_cte),
              (SELECT finish_reason_id FROM finish_reason_cte),
              (SELECT editor_name_id FROM editor_name_cte)
          )
          UPDATE kilocode_users
          SET microdollars_used = microdollars_used + ${coreUsageFields.cost}
          WHERE id = ${coreUsageFields.kilo_user_id}
            AND ${coreUsageFields.organization_id}::uuid IS NULL
            AND ${coreUsageFields.cost} > 0
          RETURNING microdollars_used AS new_microdollars_used, kilo_pass_threshold
        `);

  // No rows returned means either: org usage (no user balance update), zero cost, or missing user
  if (!result.rows[0]) {
    // Only log error if we expected an update (non-org, positive cost)
    if (!coreUsageFields.organization_id && coreUsageFields.cost && coreUsageFields.cost > 0) {
      captureMessage('impossible: missing user', {
        level: 'fatal',
        tags: { source: 'insertUsageAndUpdateBalance' },
        extra: { coreUsageFields },
      });
    }
    return null;
  }

  // Convert BigInt to number (microdollars_used is a bigint column)
  const newMicrodollarsUsed = Number(result.rows[0].new_microdollars_used);

  const kiloPassThreshold =
    result.rows[0].kilo_pass_threshold == null ? null : Number(result.rows[0].kilo_pass_threshold);

  const effectiveKiloPassThreshold = getEffectiveKiloPassThreshold(kiloPassThreshold);

  if (effectiveKiloPassThreshold !== null && newMicrodollarsUsed >= effectiveKiloPassThreshold) {
    // Trigger this async to avoid blocking
    void maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: coreUsageFields.kilo_user_id,
      nowIso: coreUsageFields.created_at,
    }).catch(async error => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await appendKiloPassAuditLog(db, {
        action: KiloPassAuditLogAction.BonusCreditsIssued,
        result: KiloPassAuditLogResult.Failed,
        kiloUserId: coreUsageFields.kilo_user_id,
        payload: {
          source: 'usage_threshold',
          error: errorMessage,
        },
      });
    });
  }

  return { newMicrodollarsUsed };
}

export function countAndStoreUsage(
  clonedReponse: Response,
  usageContext: MicrodollarUsageContext,
  openrouterRequestSpan: Span | undefined
) {
  const usageStatsPromise = !clonedReponse.body
    ? Promise.resolve(null)
    : usageContext.isStreaming
      ? parseMicrodollarUsageFromStream(
          clonedReponse.body,
          usageContext.kiloUserId,
          openrouterRequestSpan,
          usageContext.provider,
          clonedReponse.status
        )
      : clonedReponse
          .text()
          .then(content =>
            parseMicrodollarUsageFromString(content, usageContext.kiloUserId, clonedReponse.status)
          );

  return usageStatsPromise.then(usageStats => processTokenData(usageStats, usageContext));
}

type OpenRouterError = {
  message: string;
  code: string;
  metadata?: Record<string, unknown>;
  provider_name?: string;
};

export function processOpenRouterUsage(
  usage: OpenRouterUsage | null | undefined,
  coreProps: NotYetCostedUsageStats
): JustTheCostsUsageStats {
  const is_byok = usage?.is_byok ?? null;
  const openrouterCost_USD = usage?.cost ?? 0;
  const upstream_inference_cost_USD = usage?.cost_details?.upstream_inference_cost ?? 0;
  const cost_mUsd = toMicrodollars(is_byok ? upstream_inference_cost_USD : openrouterCost_USD);
  const inferredUpstream_USD = openrouterCost_USD * OPENROUTER_BYOK_COST_MULTIPLIER;
  const microdollar_error = (inferredUpstream_USD - upstream_inference_cost_USD) * 1000000;
  if (
    (is_byok == null && (openrouterCost_USD || upstream_inference_cost_USD)) || // unknown byok status but known non-zero costs? We're borked!
    (is_byok && usage?.cost !== 0 && 1.1 < Math.abs(microdollar_error)) // byok and cost is not 5% of upstream? Weird, EXCEPT sometimes cost is 0 due to openrouter promo.
  ) {
    const { responseContent: _ignore, ...corePropsCopy } = coreProps;
    captureMessage("SUSPICIOUS: openrouters cost accounting doesn't make sense", {
      level: 'error',
      tags: { source: 'sse_processing' },
      extra: {
        ...corePropsCopy,
        cost_mUsd,
        is_byok,
        openrouterCost_USD,
        upstream_inference_cost_USD,
        inferredUpstream_USD,
        microdollar_error,
      },
    });
  }

  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    cacheHitTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cost_mUsd,
    is_byok,
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
  const startedAt = performance.now();
  let firstTokenReceived = false;
  let usage: OpenRouterUsage | null = null;
  let inference_provider: string | null = null;
  let finish_reason: string | null = null;

  const reader = stream.getReader();
  const decoder = new TextDecoder();

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
        captureException(new Error(`OpenRouter error: ${error.message}`), {
          tags: { source: 'sse_processing' },
          extra: { json, event },
        });
      }

      model = json.model ?? model;
      messageId = json.id ?? messageId;
      usage = json.usage ?? usage;
      const choice = json.choices?.[0];
      inference_provider =
        json.provider ??
        choice?.delta?.provider_metadata?.gateway?.routing?.resolvedProvider ??
        inference_provider;
      finish_reason = choice?.finish_reason ?? finish_reason;

      const contentDelta = choice?.delta?.content;
      if (contentDelta) {
        responseContent += contentDelta;
      }
    },
  });

  let wasAborted = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      sseStreamParser.feed(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    // Handle client abort - the stream was terminated but we may have partial data
    if (error instanceof Error && error.name === 'ResponseAborted') {
      wasAborted = true;
      // Continue to process whatever data we've collected
    } else {
      throw error;
    }
  } finally {
    reader.releaseLock();
    streamProcessingSpan.end();
  }

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
    hasError: reportedError || wasAborted,
    model,
    responseContent,
    inference_provider,
    finish_reason,
    upstream_id: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: true,
    cancelled: null,
  };

  const costs = processOpenRouterUsage(usage, coreProps);

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
  const coreProps = {
    kiloUserId,
    messageId: responseJson?.id ?? null,
    hasError: !responseJson?.model || statusCode >= 400,
    model: responseJson?.model ?? null,
    responseContent: choice?.message.content ?? '',
    inference_provider:
      responseJson?.provider ??
      choice?.message?.provider_metadata?.gateway?.routing?.resolvedProvider ??
      null,
    upstream_id: null,
    finish_reason: choice?.finish_reason ?? null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: false,
    cancelled: null,
  };

  const costs = processOpenRouterUsage(responseJson?.usage, coreProps);

  return { ...coreProps, ...costs };
}

async function processTokenData(
  usageStats: MicrodollarUsageStats | null,
  usageContext: MicrodollarUsageContext
) {
  if (!usageStats) {
    captureMessage('SUSPICIOUS: No usage information', {
      level: 'error',
      tags: { source: 'usage_processing' },
      extra: { usageContext },
    });
    return;
  }

  const timer = createTimer();
  const provider = Object.values(PROVIDERS).find(p => p.id === usageContext.provider);
  const generation =
    provider?.hasGenerationEndpoint &&
    usageStats.messageId &&
    (await fetchGeneration(usageStats.messageId, provider));
  if (usageStats.messageId) {
    timer.log(`fetch generation for message ${usageStats.messageId}`);
  }
  if (generation) {
    const genStats = mapToUsageStats(
      generation,
      usageStats.responseContent,
      usageContext.kiloUserId
    );

    genStats.model = usageStats.model; // openrouter bug?
    genStats.hasError = usageStats.hasError; // retain by choice
    genStats.streamed ??= usageContext.isStreaming;
    if (genStats.cost_mUsd !== usageStats.cost_mUsd) {
      console.warn(
        `DEV ODDITY / WARNING: Usage stats do not match generation data:`,
        genStats.model,
        [genStats.cost_mUsd, usageStats.cost_mUsd],
        [genStats.cacheDiscount_mUsd, usageStats.cacheDiscount_mUsd]
      );
    }
    usageStats = genStats;
  }

  if (usageStats.inputTokens - usageStats.cacheHitTokens > 100000)
    console.warn(`Abuse?: Large uncached token request detected:`, usageStats);

  if (
    !usageStats.model || // fallback for failure cases
    isStealthModelOnKiloCodeOnly(usageContext.requested_model) // this can probably be removed once we're sure we only present requested_model to users
  ) {
    usageStats.model = usageContext.requested_model;
  }

  // Report upstream cost to abuse service BEFORE zeroing for free/BYOK
  // (abuse service needs actual spend for heuristics like free_tier_exhausted)
  reportAbuseCost(usageContext, usageStats).catch(error => {
    console.error('[Abuse] Failed to report cost:', error);
  });

  if (isFreeModel(usageContext.requested_model) || usageContext.user_byok) {
    usageStats.cost_mUsd = 0;
    usageStats.cacheDiscount_mUsd = 0;
  }

  await logMicrodollarUsage(usageStats, usageContext);
}

export const mapToUsageStats = (
  { data }: OpenRouterGeneration,
  responseContent: string,
  kiloUserId: string
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
    inputTokens: data.native_tokens_prompt ?? 0,
    cacheHitTokens: data.native_tokens_cached ?? 0,
    cacheWriteTokens: 0,
    outputTokens: data.native_tokens_completion ?? 0,
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
  };
};

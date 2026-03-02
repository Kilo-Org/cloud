import { randomUUID } from 'crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as Sentry from '@sentry/cloudflare';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import {
  type MicrodollarUsageContext,
  type OpenRouterGeneration,
  isFreeModel,
  isKiloStealthModel,
  isActiveReviewPromo,
  isActiveCloudAgentPromo,
} from '@kilocode/llm-shared';
import {
  microdollar_usage,
  organizations,
  organization_user_usage,
  payment_methods,
} from '@kilocode/db/schema';
import type { MicrodollarUsage } from '@kilocode/db/schema';
import type { WorkerDb } from '../lib/db.js';
import { getWorkerDb } from '../lib/db.js';
import { reportAbuseCost, type AbuseEnv } from '../services/abuse.js';
import { logger } from '../logger.js';
import type { Env } from '../types.js';

function toMicrodollars(amount: number): number {
  return Math.round(amount * 1000000);
}

// For BYOK requests, OpenRouter only reports 5% of the actual cost.
// Although we now use upstream_inference_cost, we still do some sanity checks.
const OPENROUTER_BYOK_COST_MULTIPLIER = 20.0;

// --- Types ---

type OpenRouterUsage = {
  cost?: number;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost: number };
  completion_tokens: number;
  completion_tokens_details: { reasoning_tokens: number };
  prompt_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
  total_tokens: number;
};

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

type MicrodollarUsageStats = NotYetCostedUsageStats & JustTheCostsUsageStats;

type UsageMetaData = {
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
  machine_id: string | null;
  feature: string | null;
  session_id: string | null;
};

type ChatCompletionChunk = {
  id?: string;
  model?: string;
  usage?: OpenRouterUsage | null;
  provider?: string | null;
  error?: { message: string; code: string };
  choices?: {
    delta?: {
      content?: string;
      provider_metadata?: { gateway?: { routing?: { finalProvider?: string } } };
    };
    finish_reason?: string | null;
  }[];
};

// --- Parsing ---

function processOpenRouterUsage(
  usage: OpenRouterUsage | null | undefined,
  coreProps: NotYetCostedUsageStats
): JustTheCostsUsageStats {
  const is_byok = usage?.is_byok ?? null;
  const openrouterCost_USD = usage?.cost ?? 0;
  const upstream_inference_cost_USD = usage?.cost_details?.upstream_inference_cost ?? 0;
  const cost_mUsd = toMicrodollars(is_byok ? upstream_inference_cost_USD : openrouterCost_USD);

  // Sanity-check BYOK cost accounting
  const inferredUpstream_USD = openrouterCost_USD * OPENROUTER_BYOK_COST_MULTIPLIER;
  const microdollar_error = (inferredUpstream_USD - upstream_inference_cost_USD) * 1000000;
  if (
    (is_byok == null && (openrouterCost_USD || upstream_inference_cost_USD)) ||
    (is_byok && usage?.cost !== 0 && 1.1 < Math.abs(microdollar_error))
  ) {
    const { responseContent: _ignore, ...corePropsCopy } = coreProps;
    logger.error("SUSPICIOUS: openrouter cost accounting doesn't make sense", {
      ...corePropsCopy,
      cost_mUsd: String(cost_mUsd),
      is_byok: String(is_byok),
      openrouterCost_USD: String(openrouterCost_USD),
      upstream_inference_cost_USD: String(upstream_inference_cost_USD),
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

async function parseMicrodollarUsageFromStream(
  stream: ReadableStream,
  kiloUserId: string,
  provider: string,
  statusCode: number
): Promise<MicrodollarUsageStats> {
  let messageId: string | null = null;
  let model: string | null = null;
  let responseContent = '';
  let reportedError = statusCode >= 400;
  let usage: OpenRouterUsage | null = null;
  let inference_provider: string | null = null;
  let finish_reason: string | null = null;

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const sseStreamParser = createParser({
    onEvent(event: EventSourceMessage) {
      if (event.data === '[DONE]') return;

      let json: ChatCompletionChunk;
      try {
        json = JSON.parse(event.data);
      } catch {
        logger.warn('Failed to parse SSE event data');
        return;
      }
      if (!json) return;

      if ('error' in json && json.error) {
        reportedError = true;
        logger.error(`OpenRouter error in stream: ${json.error.message}`);
      }

      model = json.model ?? model;
      messageId = json.id ?? messageId;
      usage = (json.usage as OpenRouterUsage) ?? usage;
      const choice = json.choices?.[0];
      inference_provider =
        json.provider ??
        choice?.delta?.provider_metadata?.gateway?.routing?.finalProvider ??
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
      if (done) break;
      sseStreamParser.feed(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'ResponseAborted') {
      wasAborted = true;
    } else {
      throw error;
    }
  } finally {
    reader.releaseLock();
  }

  if (!reportedError && !usage) {
    logger.warn('No usage chunk in stream', { kiloUserId, provider, messageId, model });
  }

  const coreProps: NotYetCostedUsageStats = {
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

  return { ...coreProps, ...processOpenRouterUsage(usage, coreProps) };
}

function parseMicrodollarUsageFromString(
  fullResponse: string,
  kiloUserId: string,
  statusCode: number
): MicrodollarUsageStats {
  const responseJson = JSON.parse(fullResponse) as {
    id?: string;
    model?: string;
    usage?: OpenRouterUsage | null;
    provider?: string | null;
    choices?: {
      message?: {
        content?: string;
        provider_metadata?: { gateway?: { routing?: { finalProvider?: string } } };
      };
      finish_reason?: string | null;
    }[];
  } | null;

  if (responseJson?.usage?.is_byok == null && responseJson?.usage?.cost) {
    logger.error('SUSPICIOUS: is_byok is null', { kiloUserId });
  }

  const choice = responseJson?.choices?.[0];
  const coreProps: NotYetCostedUsageStats = {
    messageId: responseJson?.id ?? null,
    hasError: !responseJson?.model || statusCode >= 400,
    model: responseJson?.model ?? null,
    responseContent: choice?.message?.content ?? '',
    inference_provider:
      responseJson?.provider ??
      choice?.message?.provider_metadata?.gateway?.routing?.finalProvider ??
      null,
    upstream_id: null,
    finish_reason: choice?.finish_reason ?? null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: false,
    cancelled: null,
  };

  return { ...coreProps, ...processOpenRouterUsage(responseJson?.usage, coreProps) };
}

// --- Generation fetch with retry ---

async function fetchGeneration(
  messageId: string,
  providerApiUrl: string,
  apiKey: string
): Promise<OpenRouterGeneration | undefined> {
  // Small delay — OpenRouter returns 404 when called too soon
  await new Promise(res => setTimeout(res, 200));

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${providerApiUrl}/generation?id=${messageId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://kilocode.ai',
          'X-Title': 'Kilo Code',
        },
      });

      if (response.ok) {
        return (await response.json()) as OpenRouterGeneration;
      }

      if (response.status >= 500 || attempt >= 2) {
        logger.warn('Failed to fetch generation', {
          messageId,
          status: String(response.status),
        });
        return undefined;
      }

      // Retry on 4xx (OpenRouter returns 404 when called too soon)
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    } catch (error) {
      logger.warn('Error fetching generation', { messageId, error: String(error) });
      if (attempt >= 2) return undefined;
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  return undefined;
}

function mapToUsageStats(
  generation: OpenRouterGeneration,
  responseContent: string,
  kiloUserId: string
): MicrodollarUsageStats {
  const { data } = generation;
  let llmCostUsd: number;

  if (!data.is_byok) {
    llmCostUsd = data.total_cost;
  } else if (data.upstream_inference_cost == undefined) {
    logger.error('openrouter missing upstream_inference_cost', { kiloUserId });
    llmCostUsd = data.total_cost * OPENROUTER_BYOK_COST_MULTIPLIER;
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
}

// --- DB record construction ---

function extractUsageContextInfo(usageContext: MicrodollarUsageContext) {
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
    machine_id: usageContext.machine_id,
    is_user_byok: usageContext.user_byok,
    has_tools: usageContext.has_tools,
    feature: usageContext.feature,
    session_id: usageContext.session_id,
  };
}

function toInsertableDbUsageRecord(
  usageStats: MicrodollarUsageStats,
  usageContextInfo: ReturnType<typeof extractUsageContextInfo>
) {
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

  // Never log sensitive prompt data for org usage
  if (organization_id) {
    metadata.user_prompt_prefix = null;
    metadata.system_prompt_prefix = null;
  }

  return { core, metadata };
}

// --- CTE-based upsert for metadata lookup tables ---

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
const createUpsertCTE = (metaDataKindName: ReturnType<typeof sql>, value: string | null) => sql`
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

// --- DB writes ---

async function insertUsageAndMetadataWithBalanceUpdate(
  coreUsageFields: MicrodollarUsage,
  metadataFields: UsageMetaData,
  db: WorkerDb
): Promise<{ newMicrodollarsUsed: number } | null> {
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
    , ${createUpsertCTE(sql`feature`, metadataFields.feature)}
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

        http_user_agent_id,
        http_ip_id,
        vercel_ip_country_id,
        vercel_ip_city_id,
        ja4_digest_id,
        system_prompt_prefix_id,
        finish_reason_id,
        editor_name_id,
        feature_id
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

        (SELECT http_user_agent_id FROM http_user_agent_cte),
        (SELECT http_ip_id FROM http_ip_cte),
        (SELECT vercel_ip_country_id FROM vercel_ip_country_cte),
        (SELECT vercel_ip_city_id FROM vercel_ip_city_cte),
        (SELECT ja4_digest_id FROM ja4_digest_cte),
        (SELECT system_prompt_prefix_id FROM system_prompt_prefix_cte),
        (SELECT finish_reason_id FROM finish_reason_cte),
        (SELECT editor_name_id FROM editor_name_cte),
        (SELECT feature_id FROM feature_cte)
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
    if (!coreUsageFields.organization_id && coreUsageFields.cost && coreUsageFields.cost > 0) {
      Sentry.captureMessage('impossible: missing user in usage update', {
        level: 'fatal',
        extra: { coreUsageFields },
      });
    }
    return null;
  }

  const newMicrodollarsUsed = Number(result.rows[0].new_microdollars_used);

  // Kilo Pass threshold check — bonus credits when usage crosses (threshold - $1)
  const kiloPassThreshold =
    result.rows[0].kilo_pass_threshold == null ? null : Number(result.rows[0].kilo_pass_threshold);
  const effectiveThreshold =
    kiloPassThreshold === null ? null : Math.max(0, kiloPassThreshold - 1_000_000);

  if (effectiveThreshold !== null && newMicrodollarsUsed >= effectiveThreshold) {
    // TODO: Port maybeIssueKiloPassBonusFromUsageThreshold
    // Non-critical background task — log and move on.
    logger.info('Kilo Pass threshold crossed, bonus pending implementation', {
      userId: coreUsageFields.kilo_user_id,
    });
  }

  return { newMicrodollarsUsed };
}

async function insertUsageRecord(
  coreUsageFields: MicrodollarUsage,
  metadataFields: UsageMetaData,
  db: WorkerDb
): Promise<{ newMicrodollarsUsed: number } | null> {
  let attempt = 0;
  while (true) {
    try {
      return await insertUsageAndMetadataWithBalanceUpdate(coreUsageFields, metadataFields, db);
    } catch (error) {
      if (attempt >= 2) {
        logger.error('insertUsageRecord failed after retries', { error: String(error) });
        Sentry.captureException(error, { tags: { source: 'insertUsageRecord' } });
        return null;
      }
      logger.warn('insertUsageRecord concurrency failure, retrying', { error: String(error) });
      await new Promise(r => setTimeout(r, Math.random() * 100));
      attempt++;
    }
  }
}

// --- Organization token usage ---

async function ingestOrganizationTokenUsage(usage: MicrodollarUsage, db: WorkerDb): Promise<void> {
  const { cost, kilo_user_id, organization_id } = usage;
  if (!organization_id) return;

  try {
    // Update organization usage
    await db
      .update(organizations)
      .set({
        microdollars_used: sql`${organizations.microdollars_used} + ${cost}`,
        microdollars_balance: sql`${organizations.microdollars_balance} - ${cost}`,
      })
      .where(eq(organizations.id, organization_id));

    // Upsert user daily usage
    await db.execute(sql`
      INSERT INTO ${organization_user_usage} (
        organization_id,
        kilo_user_id,
        usage_date,
        limit_type,
        microdollar_usage,
        created_at,
        updated_at
      )
      SELECT
        ${organization_id},
        ${kilo_user_id},
        CURRENT_DATE,
        'daily',
        ${cost},
        NOW(),
        NOW()
      ON CONFLICT (organization_id, kilo_user_id, limit_type, usage_date)
      DO UPDATE SET
        microdollar_usage = ${organization_user_usage.microdollar_usage} + ${cost},
        updated_at = NOW()
    `);

    // TODO: Port balance alert threshold email check
  } catch (error) {
    logger.error('Failed to ingest organization token usage', { error: String(error) });
  }
}

// --- PostHog events via HTTP Capture API ---

async function sendPostHogEvent(
  distinctId: string,
  event: string,
  properties: Record<string, unknown>,
  posthogApiKey: string
): Promise<void> {
  try {
    await fetch('https://us.i.posthog.com/capture/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: posthogApiKey,
        distinct_id: distinctId,
        event,
        properties: {
          ...properties,
          $lib: 'llm-gateway-worker',
        },
      }),
    });
  } catch (error) {
    logger.warn('PostHog event failed', { event, error: String(error) });
  }
}

async function hasPaymentMethod(userId: string, db: WorkerDb): Promise<boolean> {
  const result = await db
    .select({ id: payment_methods.id })
    .from(payment_methods)
    .where(and(eq(payment_methods.user_id, userId), isNull(payment_methods.deleted_at)))
    .limit(1);
  return result.length > 0;
}

async function isFirstUsage(
  usage: MicrodollarUsage,
  priorMicrodollarUsage: number,
  db: WorkerDb
): Promise<boolean> {
  if (priorMicrodollarUsage || usage.organization_id) return false;
  // Only pay the cost of querying prior usage for non-org users with zero cost so far
  const existing = await db
    .select({ created_at: microdollar_usage.created_at })
    .from(microdollar_usage)
    .where(eq(microdollar_usage.kilo_user_id, usage.kilo_user_id))
    .limit(1);
  return existing.length === 0;
}

// --- Main entry point ---

export async function countAndStoreUsage(
  clonedResponse: Response,
  usageContext: MicrodollarUsageContext,
  env: Env
): Promise<void> {
  const { db, connect, end } = getWorkerDb(env.HYPERDRIVE.connectionString);
  await connect();

  try {
    // 1. Parse usage from response
    if (!clonedResponse.body) {
      logger.error('No response body for usage accounting');
      return;
    }

    let usageStats: MicrodollarUsageStats;

    if (usageContext.isStreaming) {
      usageStats = await parseMicrodollarUsageFromStream(
        clonedResponse.body,
        usageContext.kiloUserId,
        usageContext.provider,
        clonedResponse.status
      );
    } else {
      const content = await clonedResponse.text();
      usageStats = parseMicrodollarUsageFromString(
        content,
        usageContext.kiloUserId,
        clonedResponse.status
      );
    }

    // 2. Fetch authoritative generation data from OpenRouter
    const providerApiUrl = 'https://openrouter.ai/api/v1';
    const generation =
      usageStats.messageId &&
      usageContext.provider === 'openrouter' &&
      (await fetchGeneration(usageStats.messageId, providerApiUrl, env.OPENROUTER_API_KEY));

    if (generation) {
      const genStats = mapToUsageStats(
        generation,
        usageStats.responseContent,
        usageContext.kiloUserId
      );
      genStats.model = usageStats.model; // openrouter bug: generation may report different model
      genStats.hasError = usageStats.hasError; // retain stream-observed error state
      genStats.streamed ??= usageContext.isStreaming;
      usageStats = genStats;
    }

    // Fallback model to requested_model for failure cases or stealth models
    if (!usageStats.model || isKiloStealthModel(usageContext.requested_model)) {
      usageStats.model = usageContext.requested_model;
    }

    // 3. Report upstream cost to abuse service BEFORE zeroing for free/BYOK
    reportAbuseCost(usageContext, usageStats, env).catch(error => {
      logger.error('[Abuse] Failed to report cost', { error: String(error) });
    });

    // 4. Zero cost for free models, BYOK, and active promos
    if (
      isFreeModel(usageContext.requested_model) ||
      usageContext.user_byok ||
      isActiveReviewPromo(usageContext.botId, usageContext.requested_model) ||
      isActiveCloudAgentPromo(usageContext.tokenSource, usageContext.requested_model)
    ) {
      usageStats.cost_mUsd = 0;
      usageStats.cacheDiscount_mUsd = 0;
    }

    // 5. Build and insert usage record
    const contextInfo = extractUsageContextInfo(usageContext);
    const { core, metadata } = toInsertableDbUsageRecord(usageStats, contextInfo);

    const isFirst = await isFirstUsage(core, usageContext.prior_microdollar_usage, db);

    // PostHog: first_usage event
    if (isFirst && usageContext.posthog_distinct_id && env.POSTHOG_API_KEY) {
      const userHasPaymentMethod = await hasPaymentMethod(core.kilo_user_id, db);
      await sendPostHogEvent(
        usageContext.posthog_distinct_id,
        'first_usage',
        {
          model: core.model,
          cost_mUsd: core.cost,
          has_payment_method: userHasPaymentMethod,
        },
        env.POSTHOG_API_KEY
      );
    }

    const balanceResult = await insertUsageRecord(core, metadata, db);

    // PostHog: first_microdollar_usage event (first time user incurs non-zero cost)
    if (balanceResult && usageContext.posthog_distinct_id && env.POSTHOG_API_KEY) {
      const priorTotal = Math.abs(balanceResult.newMicrodollarsUsed - core.cost);
      if (priorTotal < 1) {
        const userHasPaymentMethod = await hasPaymentMethod(core.kilo_user_id, db);
        await sendPostHogEvent(
          usageContext.posthog_distinct_id,
          'first_microdollar_usage',
          {
            model: core.model,
            cost_mUsd: core.cost,
            has_payment_method: userHasPaymentMethod,
            has_prior_free_usage: !isFirst,
          },
          env.POSTHOG_API_KEY
        );
      }
    }

    // 6. Organization token usage tracking
    await ingestOrganizationTokenUsage(core, db);
  } catch (error) {
    logger.error('Usage accounting failed', { error: String(error) });
    Sentry.captureException(error, { tags: { source: 'usage_accounting' } });
  } finally {
    await end().catch(() => {});
  }
}

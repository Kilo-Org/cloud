import { DEFAULT_AUTO_ROUTER, type MirrorPayload } from '@kilocode/auto-routing-contracts';
import { UsageRecordRequestSchema, type UsageRecordRequest } from '@kilocode/usage-contracts';
import { withDORetry } from '@kilocode/worker-utils';
import { sha256Hex } from '@kilocode/worker-utils/sha256';
import { recordUsage, type UsageWriteOutcome } from '@kilocode/worker-utils/usage-writer-client';
import { ZodError } from 'zod';

export type ClassifierCallKind = 'sync' | 'background' | 'speculative';

export type ClassifierUsageIdentity = {
  conversationKey: string;
  classifierModel: string;
  contentHash: string;
  kind: ClassifierCallKind;
  requestStart: string;
};

type ClassifierUsageEnv = Pick<
  Env,
  'AUTO_ROUTING_DECISION_CACHE' | 'INTERNAL_API_SECRET_PROD' | 'KILO_WEB_API_BASE_URL'
>;

function clean(value: string | null): string | null {
  return value?.replaceAll('\u0000', '') ?? null;
}

export async function buildClassifierUsage(
  payload: MirrorPayload,
  identity: ClassifierUsageIdentity,
  costUsd: number,
  createdAt: string
): Promise<UsageRecordRequest> {
  const hash = await sha256Hex(
    JSON.stringify([
      payload.router ?? DEFAULT_AUTO_ROUTER,
      identity.conversationKey,
      identity.classifierModel,
      identity.contentHash,
      identity.kind,
      identity.requestStart,
    ])
  );
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash[16] ?? '0', 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return UsageRecordRequestSchema.parse({
    core: {
      id,
      kilo_user_id: clean(payload.userId),
      cost: Math.round(costUsd * 1_000_000),
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: createdAt,
      provider: 'openrouter',
      model: 'auto-routing/classifier',
      requested_model: clean(payload.input.requestedModel.toLowerCase()),
      cache_discount: null,
      has_error: false,
      abuse_classification: 0,
      organization_id: payload.organizationId ?? null,
      inference_provider: null,
      project_id: null,
    },
    metadata: {
      id,
      message_id: '<missing>',
      created_at: createdAt,
      http_x_forwarded_for: null,
      http_x_vercel_ip_city: null,
      http_x_vercel_ip_country: null,
      http_x_vercel_ip_latitude: null,
      http_x_vercel_ip_longitude: null,
      http_x_vercel_ja4_digest: null,
      user_prompt_prefix: payload.organizationId ? null : '',
      system_prompt_prefix: payload.organizationId ? null : '',
      system_prompt_length: 0,
      http_user_agent: clean(payload.userAgent),
      max_tokens: null,
      has_middle_out_transform: null,
      status_code: 200,
      upstream_id: null,
      finish_reason: null,
      latency: null,
      moderation_latency: null,
      generation_time: null,
      is_byok: false,
      is_user_byok: false,
      streamed: false,
      cancelled: false,
      editor_name: null,
      api_kind: payload.input.apiKind,
      has_tools: false,
      machine_id: clean(payload.machineId),
      feature: null,
      session_id: clean(payload.sessionId),
      mode: clean(payload.mode),
      auto_model: clean(payload.input.requestedModel.toLowerCase()),
      reasoning_setting: null,
      market_cost: Math.round(costUsd * 1_000_000),
      is_free: false,
      abuse_delay: null,
      abuse_downgraded_from: null,
    },
    prior_microdollar_usage: 0,
    posthog_distinct_id: null,
  });
}

export async function writeClassifierUsage(
  env: Pick<ClassifierUsageEnv, 'INTERNAL_API_SECRET_PROD' | 'KILO_WEB_API_BASE_URL'>,
  usage: UsageRecordRequest
): Promise<UsageWriteOutcome> {
  try {
    return await recordUsage(usage, {
      url: new URL('/api/internal/usage/record', env.KILO_WEB_API_BASE_URL).href,
      secret: await env.INTERNAL_API_SECRET_PROD.get(),
    });
  } catch {
    return { kind: 'unavailable', reason: 'missing_config' };
  }
}

export async function recordClassifierUsage(
  env: ClassifierUsageEnv,
  payload: MirrorPayload,
  identity: ClassifierUsageIdentity,
  costUsd: number | null | undefined,
  createdAt: string
): Promise<void> {
  if (costUsd == null) return;
  let usage: UsageRecordRequest;
  try {
    usage = await buildClassifierUsage(payload, identity, costUsd, createdAt);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    for (const issue of error.issues) {
      console.warn(
        JSON.stringify({
          event: 'auto_routing_classifier_usage_invalid',
          fieldPath: issue.path.join('.'),
        })
      );
    }
    return;
  }
  await withDORetry(
    () =>
      env.AUTO_ROUTING_DECISION_CACHE.get(
        env.AUTO_ROUTING_DECISION_CACHE.idFromName(
          `${payload.router ?? DEFAULT_AUTO_ROUTER}:${identity.conversationKey}`
        )
      ),
    stub => stub.recordClassifierUsage(usage),
    'recordClassifierUsage'
  );
}

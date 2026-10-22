import type { ClientEvalBilling } from '@kilocode/auto-routing-contracts';
import { UsageRecordRequestSchema, type UsageRecordRequest } from '@kilocode/usage-contracts';
import { sha256Hex } from '@kilocode/worker-utils/sha256';
import { recordUsage, type UsageWriteOutcome } from '@kilocode/worker-utils/usage-writer-client';

export const GRADER_USAGE_MODEL = 'auto-routing/grader';

/**
 * Judged grading of a client eval upload is billed to the paying owner (ADR 0005
 * invariant 6), shaped like the serving worker's `auto-routing/classifier` usage.
 * The id is derived from the graded case, so a retried upload records it once.
 */
export async function buildGraderUsage(
  billing: ClientEvalBilling,
  gradedCase: readonly (string | number | null)[],
  costUsd: number,
  createdAt: string
): Promise<UsageRecordRequest> {
  const hash = await sha256Hex(JSON.stringify([GRADER_USAGE_MODEL, ...gradedCase]));
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash[16] ?? '0', 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const microdollars = Math.round(costUsd * 1_000_000);
  return UsageRecordRequestSchema.parse({
    core: {
      id,
      kilo_user_id: billing.userId,
      cost: microdollars,
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: createdAt,
      provider: 'openrouter',
      model: GRADER_USAGE_MODEL,
      requested_model: null,
      cache_discount: null,
      has_error: false,
      abuse_classification: 0,
      organization_id: billing.organizationId,
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
      user_prompt_prefix: billing.organizationId ? null : '',
      system_prompt_prefix: billing.organizationId ? null : '',
      system_prompt_length: 0,
      http_user_agent: null,
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
      api_kind: 'systemone',
      has_tools: false,
      machine_id: null,
      feature: null,
      session_id: null,
      mode: null,
      auto_model: null,
      reasoning_setting: null,
      market_cost: microdollars,
      addon_cost: null,
      is_free: false,
      abuse_delay: null,
      abuse_downgraded_from: null,
    },
    prior_microdollar_usage: 0,
    posthog_distinct_id: null,
  });
}

export async function writeGraderUsage(
  env: Pick<Env, 'INTERNAL_API_SECRET_PROD' | 'KILO_WEB_API_BASE_URL'>,
  usage: UsageRecordRequest
): Promise<UsageWriteOutcome> {
  return recordUsage(usage, {
    url: new URL('/api/internal/usage/record', env.KILO_WEB_API_BASE_URL).href,
    secret: await env.INTERNAL_API_SECRET_PROD.get(),
  });
}

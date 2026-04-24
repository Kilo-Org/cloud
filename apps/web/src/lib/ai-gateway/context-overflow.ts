import { NextResponse } from 'next/server';
import { z } from 'zod';
import { kiloExclusiveModels } from '@/lib/ai-gateway/models';
import { getMaxTokens } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { ProxyErrorType } from '@/lib/proxy-error-types';
import { warnExceptInTest } from '@/lib/utils.server';

// Recursively sums the lengths of every string value in a structure. Used by
// `estimateTokenCount` to get a text-only character count that ignores JSON
// keys and punctuation.
function sumTextCharLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + sumTextCharLength(item), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce<number>((sum, v) => sum + sumTextCharLength(v), 0);
  }
  return 0;
}

// Underestimates tokens on purpose: we only count actual text content (not JSON
// punctuation or field names), then add the reserved max output tokens. This
// count is used to detect context overflows on vague upstream errors, so we
// would rather miss some cases than falsely claim a context overflow.
export function estimateTokenCount(request: GatewayRequest): number {
  return Math.round(sumTextCharLength(request.body) / 4 + (getMaxTokens(request) ?? 0));
}

// Matches upstream responses like:
//   "This endpoint's maximum context length is 204800 tokens. However, you
//    requested about 301688 tokens (...)."
const UPSTREAM_CONTEXT_OVERFLOW_PATTERN = /maximum context length is\s+\d+\s+tokens/i;

const upstreamErrorBodySchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string() })]),
});

// Returns the upstream's parsed JSON body when it already explains the
// context overflow clearly, so we can pass the body through unchanged and
// only attach `error_type` at the top level. We only rewrite when the body
// is valid JSON with a recognized error shape; plain-text or unknown-shape
// bodies are left to the generic estimate-based path below (or forwarded
// unchanged).
async function extractUpstreamContextOverflowBody(response: Response): Promise<object | null> {
  const parsedJson: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (typeof parsedJson !== 'object' || parsedJson === null || Array.isArray(parsedJson)) {
    return null;
  }
  const parsed = upstreamErrorBodySchema.safeParse(parsedJson);
  if (!parsed.success) return null;
  const err = parsed.data.error;
  const message = typeof err === 'string' ? err : err.message;
  if (!UPSTREAM_CONTEXT_OVERFLOW_PATTERN.test(message)) return null;
  return parsedJson;
}

// Detects and responds to context-overflow situations in two cases:
//   1. Upstream's JSON body explicitly says the context length was exceeded —
//      we pass the body through unchanged and just add `error_type` at the
//      top level.
//   2. Upstream returns a generic 500 ("Internal Server Error", "No allowed
//      providers are available for the selected model", etc.) and our own
//      conservative token estimate already exceeds the model's window — we
//      build a response body from our own numbers.
// Returns `null` when no context overflow is detected.
export async function detectContextOverflow({
  requestedModel,
  request,
  response,
}: {
  requestedModel: string;
  request: GatewayRequest;
  response: Response;
}): Promise<NextResponse | null> {
  const upstreamBody = await extractUpstreamContextOverflowBody(response);
  if (upstreamBody) {
    warnExceptInTest(`Responding with ${response.status} upstream context-length overflow`);
    return NextResponse.json(
      { ...upstreamBody, error_type: ProxyErrorType.context_length_exceeded },
      { status: response.status }
    );
  }

  if (response.status !== 500) return null;
  const model = kiloExclusiveModels.find(m => m.public_id === requestedModel);
  if (!model) return null;
  const estimatedTokenCount = estimateTokenCount(request);
  if (estimatedTokenCount < model.context_length) return null;

  const error = `The maximum context length is ${model.context_length} tokens. However, about ${estimatedTokenCount} tokens were requested.`;
  warnExceptInTest(`Responding with ${response.status} ${error}`);
  return NextResponse.json(
    { error, error_type: ProxyErrorType.context_length_exceeded, message: error },
    { status: response.status }
  );
}

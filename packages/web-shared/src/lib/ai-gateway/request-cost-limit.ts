import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { modelsByProvider, StoredModelSchema, type StoredModel } from '@kilocode/db';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getModelDisplayPricing } from './providers/openrouter/display-pricing';
import {
  getVercelModelIdOverrides,
  mapResolvedModelIdToVercel,
} from './providers/vercel/mapModelIdToVercel';
import { getCustomPricing } from './custom-pricing.constants';
import { findKiloExclusiveModel } from './kilo-exclusive-models';

export function textRequestPriceCeiling(metadata: StoredModel) {
  if (metadata.endpoints.length === 0) throw new Error('Model pricing is unavailable');
  let inputRate = 0;
  let outputRate = 0;
  let requestCost = 0;
  for (const endpoint of metadata.endpoints) {
    const price = getModelDisplayPricing(endpoint.pricing);
    if (!price) throw new Error('Model has an unpriced route');
    const values = [
      price.prompt,
      price.completion,
      price.request ?? '0',
      price.input_cache_write ?? '0',
      price.input_cache_read ?? '0',
      price.internal_reasoning ?? '0',
    ].map(Number);
    if (values.some(value => !Number.isFinite(value) || value < 0))
      throw new Error('Model has invalid pricing');
    inputRate = Math.max(inputRate, values[0] + Math.max(values[3], values[4]));
    outputRate = Math.max(outputRate, values[1] + values[5]);
    requestCost = Math.max(requestCost, values[2]);
  }
  const billedTiers = [
    ...(getCustomPricing(metadata.id)?.pricing ?? []),
    ...(findKiloExclusiveModel(metadata.id)?.pricing?.tiers ?? []),
  ];
  for (const { pricing } of billedTiers) {
    const input =
      Math.max(
        pricing.prompt_per_million,
        pricing.input_cache_write_per_million ?? 0,
        pricing.input_cache_read_per_million ?? 0
      ) / 1_000_000;
    const output = pricing.completion_per_million / 1_000_000;
    if (![input, output].every(value => Number.isFinite(value) && value >= 0))
      throw new Error('Model has invalid billed pricing');
    inputRate = Math.max(inputRate, input);
    outputRate = Math.max(outputRate, output);
  }
  return { inputRate, outputRate, requestCost };
}
function requestTextBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Array.isArray(value)) {
    return (value as unknown[]).reduce<number>((sum, item) => sum + requestTextBytes(item), 0);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (sum, item) => sum + requestTextBytes(item),
      0
    );
  }
  return 0;
}
/** OpenAI serves at most this many choices per request; a larger count is refused as unpricable. */
const MAX_BOUNDED_CHOICES = 128;

/** A property the bound cannot raise, accepted at any value. */
const inertProperty = z.unknown().optional();

/**
 * Admission prices one output ceiling per choice. Every top-level property is
 * either priced below or declared as unable to raise that ceiling or add a
 * server-side charge; a property outside both sets is refused instead of
 * forwarded unpriced.
 */
const boundedRequestProperties = z
  .object({
    model: z.string().optional(),
    messages: z.array(
      z.object({
        role: z.enum(['system', 'user']),
        content: z.union([
          z.string(),
          z.array(
            z
              .object({
                type: z.literal('text'),
                text: z.string(),
                cache_control: z
                  .object({ type: z.literal('ephemeral'), ttl: z.enum(['5m', '1h']).optional() })
                  .strict()
                  .optional(),
              })
              .strict()
          ),
        ]),
      })
    ),
    stream: z.literal(false),
    tools: z.never().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    n: z.number().int().positive().max(MAX_BOUNDED_CHOICES).optional(),
    temperature: inertProperty,
    top_p: inertProperty,
    top_k: inertProperty,
    stop: inertProperty,
    seed: inertProperty,
    presence_penalty: inertProperty,
    frequency_penalty: inertProperty,
    logit_bias: inertProperty,
    logprobs: inertProperty,
    top_logprobs: inertProperty,
    response_format: inertProperty,
    parallel_tool_calls: inertProperty,
    prediction: inertProperty,
    user: inertProperty,
    metadata: inertProperty,
    store: inertProperty,
    stream_options: inertProperty,
    service_tier: z.enum(['auto', 'default', 'flex']).optional(),
    prompt_cache_key: inertProperty,
    safety_identifier: inertProperty,
    session_id: inertProperty,
    provider: inertProperty,
    providerOptions: inertProperty,
    transforms: inertProperty,
    reasoning: inertProperty,
    reasoning_effort: inertProperty,
    include_reasoning: inertProperty,
    enable_thinking: inertProperty,
    thinking: inertProperty,
    verbosity: inertProperty,
  })
  .strict();

const boundedRequestSchema = boundedRequestProperties.refine(
  request => request.max_tokens !== undefined || request.max_completion_tokens !== undefined
);

export async function enforceRequestCostLimit(
  header: string | null,
  model: string,
  body: unknown,
  availableBalanceMicrodollars: number
): Promise<string | null> {
  if (header === null) return null;
  const maximum = Number(header);
  if (!Number.isSafeInteger(maximum) || maximum <= 0) return 'Invalid request spend safeguard';
  const parsed = boundedRequestSchema.safeParse(body);
  if (!parsed.success)
    return 'Bounded spending requires a text-only request with an explicit output token limit and no tools';
  const [catalog] = await db
    .select({ models: modelsByProvider.openrouter })
    .from(modelsByProvider)
    .orderBy(desc(modelsByProvider.id))
    .limit(1);
  const requestedMetadata = StoredModelSchema.safeParse(catalog?.models?.[model]);
  const aliasTarget =
    model.startsWith('~') && requestedMetadata.success
      ? requestedMetadata.data.alias_target?.slug
      : undefined;
  const metadata = aliasTarget
    ? StoredModelSchema.safeParse(catalog?.models?.[aliasTarget])
    : requestedMetadata;
  if (!metadata.success) return 'Current model pricing is unavailable for bounded spending';
  try {
    if (
      aliasTarget &&
      parsed.data.model !== model &&
      parsed.data.model !==
        mapResolvedModelIdToVercel(aliasTarget, await getVercelModelIdOverrides())
    )
      return 'Model alias target changed before bounded spending admission';
    const price = textRequestPriceCeiling(metadata.data);
    const inputTokenCeiling = requestTextBytes(body) + 2048;
    // max_completion_tokens supersedes max_tokens where both are accepted, so the larger of the
    // two bounds either resolution; every requested choice carries its own output ceiling.
    const outputTokenCeiling =
      Math.max(parsed.data.max_tokens ?? 0, parsed.data.max_completion_tokens ?? 0) *
      (parsed.data.n ?? 1);
    const bound = Math.ceil(
      (inputTokenCeiling * price.inputRate +
        outputTokenCeiling * price.outputRate +
        price.requestCost) *
        1_000_000
    );
    if (bound > maximum) return 'Request exceeds its spend safeguard before generation';
    if (bound > availableBalanceMicrodollars)
      return 'Request exceeds the available context balance or allowance';
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Request pricing unavailable';
  }
}

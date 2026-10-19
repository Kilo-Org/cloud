import { z } from 'zod';
import { getCustomPricing } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { findKiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import type { PricingTiers } from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import {
  findSupportedFimModel,
  SUPPORTED_FIM_MODELS,
} from '@kilocode/web-shared/lib/ai-gateway/supported-fim-models';

type QuoteInput = {
  apiKind: string;
  model: string;
  providerId: string;
  body: unknown;
};

type Quote =
  | { kind: 'quoted'; amountMicrodollars: number }
  | { kind: 'unsupported'; reason: string };

const textApiKinds: Record<string, true> = {
  chat_completions: true,
  messages: true,
  responses: true,
};
const safeFields: Record<string, true> = {
  model: true,
  messages: true,
  input: true,
  instructions: true,
  system: true,
  prompt: true,
  suffix: true,
  max_tokens: true,
  max_completion_tokens: true,
  max_output_tokens: true,
  min_tokens: true,
  n: true,
  best_of: true,
  stream: true,
  stream_options: true,
  stop: true,
  stop_sequences: true,
  temperature: true,
  top_p: true,
  top_k: true,
  frequency_penalty: true,
  presence_penalty: true,
  repetition_penalty: true,
  seed: true,
  logit_bias: true,
  logprobs: true,
  top_logprobs: true,
  tools: true,
  tool_choice: true,
  parallel_tool_calls: true,
  functions: true,
  function_call: true,
  response_format: true,
  text: true,
  reasoning: true,
  reasoning_effort: true,
  thinking: true,
  enable_thinking: true,
  include_reasoning: true,
  include: true,
  metadata: true,
  user: true,
  session_id: true,
  service_tier: true,
  provider: true,
  cache_control: true,
  store: true,
  safety_identifier: true,
  prompt_cache_key: true,
};
const routingFields: Record<string, true> = {
  order: true,
  only: true,
  ignore: true,
  sort: true,
  data_collection: true,
  zdr: true,
  require_parameters: true,
  allow_fallbacks: true,
};
const textPartTypes: Record<string, true> = {
  text: true,
  input_text: true,
  output_text: true,
  thinking: true,
  redacted_thinking: true,
  tool_use: true,
  tool_result: true,
  function: true,
  function_call: true,
  function_call_output: true,
  message: true,
};
const mediaFields: Record<string, true> = {
  image_url: true,
  input_audio: true,
  audio: true,
  file_id: true,
  file_data: true,
  video_url: true,
  attachments: true,
};
const requestBodySchema = z.record(z.string(), z.unknown());
const outputLimitFields = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'] as const;
const textPayloadFields = [
  'messages',
  'input',
  'system',
  'prompt',
  'suffix',
  'instructions',
] as const;

function unsupported(reason: string): Quote {
  return { kind: 'unsupported', reason };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function quoted(amount: number): Quote {
  const amountMicrodollars = Math.ceil(amount);
  return positiveInteger(amountMicrodollars)
    ? { kind: 'quoted', amountMicrodollars }
    : unsupported('reservation_amount_is_not_a_positive_safe_integer');
}

function textOnly(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(textOnly);
  if (value === null || typeof value !== 'object') return true;
  const keys = Object.keys(value);
  if (keys.some(key => Object.hasOwn(mediaFields, key))) return false;
  const partType = 'type' in value ? value.type : undefined;
  if (typeof partType === 'string' && !Object.hasOwn(textPartTypes, partType)) return false;
  // Client tool input is opaque tokenized JSON, not nested media or server operations.
  if (partType === 'tool_use' && keys.includes('type')) {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (key !== 'input' && !textOnly(record[key])) return false;
    }
    return true;
  }
  return Object.values(value).every(textOnly);
}

function payloadRejection(body: Record<string, unknown>): string | undefined {
  for (const key in body) {
    if (Object.hasOwn(body, key) && body[key] !== undefined && !Object.hasOwn(safeFields, key)) {
      return `unbounded_request_field:${key}`;
    }
  }
  for (const key of textPayloadFields) {
    if (!textOnly(body[key])) return `unsupported_media_or_hosted_operation:${key}`;
  }
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) ||
      body.tools.some(
        tool =>
          tool === null ||
          typeof tool !== 'object' ||
          Array.isArray(tool) ||
          ('type' in tool && tool.type !== 'function')
      ))
  )
    return 'hosted_tool_has_no_charge_ceiling';
  if (
    body.provider !== undefined &&
    (body.provider === null || typeof body.provider !== 'object' || Array.isArray(body.provider))
  )
    return 'invalid_provider_preferences';
  if (body.provider !== undefined && body.provider !== null && typeof body.provider === 'object') {
    for (const key in body.provider) {
      if (Object.hasOwn(body.provider, key) && !Object.hasOwn(routingFields, key)) {
        return `unbounded_provider_option:${key}`;
      }
    }
  }
  if (
    body.service_tier !== undefined &&
    !['auto', 'default', 'flex'].includes(String(body.service_tier))
  ) {
    return 'service_tier_has_no_charge_ceiling';
  }
  return undefined;
}

function samples(body: Record<string, unknown>): number | undefined {
  const n = body.n ?? 1;
  const bestOf = body.best_of ?? n;
  if (!positiveInteger(n) || !positiveInteger(bestOf) || bestOf < n) return undefined;
  return bestOf;
}

function enforceOutputCap(
  body: Record<string, unknown>,
  apiKind: string,
  maximum: number
): number | undefined {
  if (!positiveInteger(maximum)) return undefined;
  let outputTokens = maximum;
  for (const field of outputLimitFields) {
    const value = body[field];
    if (value !== undefined && value !== null && !positiveInteger(value)) return undefined;
    if (positiveInteger(value)) outputTokens = Math.min(outputTokens, value);
  }
  const field =
    apiKind === 'responses'
      ? 'max_output_tokens'
      : apiKind === 'messages'
        ? 'max_tokens'
        : 'max_completion_tokens';
  body[field] = outputTokens;
  for (const other of outputLimitFields) {
    if (other !== field && body[other] !== undefined) body[other] = outputTokens;
  }
  return outputTokens;
}

function fullContextFixedPrice(
  context: number,
  outputTokens: number,
  pricing: PricingTiers
): Quote {
  if (!positiveInteger(context)) return unsupported('missing_hard_context_ceiling');
  let maxInputRate = 0;
  let maxOutputRate = 0;
  for (const tier of pricing) {
    const rates = tier.pricing;
    const promptRate = rates.prompt_per_million;
    const cacheWriteRate = rates.input_cache_write_per_million ?? promptRate;
    const cacheReadRate = rates.input_cache_read_per_million ?? promptRate;
    if (
      !Number.isFinite(promptRate) ||
      promptRate < 0 ||
      !Number.isFinite(cacheWriteRate) ||
      cacheWriteRate < 0 ||
      !Number.isFinite(cacheReadRate) ||
      cacheReadRate < 0 ||
      !Number.isFinite(rates.completion_per_million) ||
      rates.completion_per_million < 0
    )
      return unsupported('invalid_fixed_billing_rate');
    maxInputRate = Math.max(maxInputRate, promptRate, cacheWriteRate, cacheReadRate);
    maxOutputRate = Math.max(maxOutputRate, rates.completion_per_million);
  }
  // Input uses the whole configured context, including framing/system/tool tokens, not a text estimate.
  // Output uses the final enforced cap, which must include billed reasoning for the selected API.
  // Billing's input/cache categories must partition at most one model context.
  return quoted(context * maxInputRate + outputTokens * maxOutputRate);
}

function quoteDirectCompletion(input: QuoteInput, body: Record<string, unknown>): Quote {
  const model =
    findSupportedFimModel(input.model) ??
    SUPPORTED_FIM_MODELS.find(
      entry => entry.upstreamModel === input.model && entry.provider === input.providerId
    );
  if (!model || model.provider !== input.providerId || body.model !== model.upstreamModel) {
    return unsupported('unsupported_direct_completion_model_or_route');
  }
  if (input.apiKind === 'edit_completions' && model.provider !== 'inception') {
    return unsupported('unsupported_edit_provider');
  }
  if (
    input.apiKind === 'fim_completions' &&
    (typeof body.prompt !== 'string' ||
      (body.suffix !== undefined && typeof body.suffix !== 'string'))
  ) {
    return unsupported('invalid_fim_text_payload');
  }
  if (
    input.apiKind === 'edit_completions' &&
    (!Array.isArray(body.messages) ||
      body.messages.length !== 1 ||
      body.messages[0] === null ||
      typeof body.messages[0] !== 'object' ||
      !('role' in body.messages[0]) ||
      body.messages[0].role !== 'user' ||
      !('content' in body.messages[0]) ||
      typeof body.messages[0].content !== 'string')
  ) {
    return unsupported('invalid_edit_text_payload');
  }
  if (body.n !== undefined || body.best_of !== undefined || body.tools !== undefined) {
    return unsupported('unsupported_direct_completion_sampling_or_tools');
  }
  if (!positiveInteger(body.max_tokens) || body.max_tokens > 1000) {
    return unsupported('direct_completion_requires_max_tokens_between_1_and_1000');
  }
  // Published model ceilings: https://docs.mistral.ai/models/codestral-25-08 and
  // https://docs.inceptionlabs.ai/get-started/models. The larger local snapshot is conservative.
  // Local FIM/edit billing uses these fixed token rates; cached edit input is cheaper.
  return quoted(
    model.snapshotModel.context_length * (model.provider === 'mistral' ? 0.3 : 0.25) +
      body.max_tokens * (model.provider === 'mistral' ? 0.9 : 0.75)
  );
}

/** Quote only the final payload, immediately before serialization; no transforms may follow.
 * Fixed-price text quotes conservatively hold the full input context, not a validated token count.
 * Martian inherits OpenAI/Anthropic caps: https://gateway-docs.withmartian.com/api-reference/endpoints
 * Claude includes thinking: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 */
export async function quoteInferenceReservation(input: QuoteInput): Promise<Quote> {
  if (input.apiKind === 'audio_transcriptions') {
    return unsupported('transcription_requires_verified_audio_duration_token_and_fee_ceilings');
  }
  if (input.apiKind === 'embeddings') {
    return unsupported(
      'embeddings_require_aggregate_batch_token_and_maximum_route_price_contracts'
    );
  }
  if (input.apiKind === 'systemone') {
    return unsupported(
      'systemone_requires_question_expansion_sample_and_maximum_route_charge_contracts'
    );
  }
  if (
    !Object.hasOwn(textApiKinds, input.apiKind) &&
    input.apiKind !== 'fim_completions' &&
    input.apiKind !== 'edit_completions'
  ) {
    return unsupported(`unsupported_api_kind:${input.apiKind}`);
  }
  if (input.body === null || typeof input.body !== 'object' || Array.isArray(input.body))
    return unsupported('request_body_is_not_an_object');
  const parsed = requestBodySchema.safeParse(input.body);
  if (!parsed.success) return unsupported('request_body_is_not_an_object');
  const body = parsed.data;
  if (input.apiKind === 'fim_completions' || input.apiKind === 'edit_completions') {
    const rejection = payloadRejection(body);
    if (rejection) return unsupported(rejection);
    return quoteDirectCompletion(input, body);
  }
  const sampleCount = samples(body);
  if (sampleCount === undefined) return unsupported('invalid_sample_count');
  const exclusive = findKiloExclusiveModel(input.model);
  if (exclusive) {
    if (
      !positiveInteger(exclusive.context_length) ||
      !positiveInteger(exclusive.max_completion_tokens)
    ) {
      return unsupported('missing_hard_context_or_output_ceiling');
    }
    if (!exclusive.pricing || exclusive.pricing.fallbackOnly)
      return unsupported('no_unconditional_paid_billing_schedule');
    if (input.providerId !== exclusive.provider.id || body.model !== exclusive.internal_id) {
      return unsupported('exclusive_model_route_or_transformed_model_mismatch');
    }
    if (input.providerId !== 'martian')
      return unsupported(`missing_total_output_cap_contract:${input.providerId}`);
    if (sampleCount !== 1) return unsupported('martian_does_not_support_multiple_samples');
    const rejection = payloadRejection(body);
    if (rejection) return unsupported(rejection);
    delete body.n;
    delete body.best_of;
    Reflect.deleteProperty(input.body, 'n');
    Reflect.deleteProperty(input.body, 'best_of');
    const outputTokens = enforceOutputCap(body, input.apiKind, exclusive.max_completion_tokens);
    if (outputTokens === undefined) return unsupported('invalid_output_token_limit');
    const result = fullContextFixedPrice(
      exclusive.context_length,
      outputTokens,
      exclusive.pricing.tiers
    );
    if (result.kind === 'unsupported') return result;
    Object.assign(input.body, body);
    return result;
  }
  const custom = getCustomPricing(input.model);
  if (!custom || custom.fallbackOnly)
    return unsupported(
      `missing_maximum_route_price_and_token_contract:${input.providerId}:${input.model}`
    );
  if (input.providerId !== 'openrouter' && input.providerId !== 'vercel') {
    return unsupported('fixed_custom_pricing_provider_not_supported');
  }
  return unsupported('fixed_custom_pricing_missing_declared_model_output_and_reasoning_ceiling');
}

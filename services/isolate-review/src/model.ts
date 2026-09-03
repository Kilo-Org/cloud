import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { z } from 'zod';
import { DEFAULT_MODEL } from './prompt';
import { IsolateReviewInferenceSchema, type IsolateReviewInference } from './types';

export const DEFAULT_KILO_GATEWAY_URL = 'https://api.kilo.ai/api/openrouter';
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 32_000;
const InferenceSchema = IsolateReviewInferenceSchema.extend({
  maxOutputTokens: z.number().int().positive().max(MAX_OUTPUT_TOKENS),
});
const ModelIdSchema = InferenceSchema.shape.modelId;
const ThinkingEffortSchema = InferenceSchema.shape.thinkingEffort;
const ProviderSchema = InferenceSchema.shape.provider;
const VariantSchema = InferenceSchema.shape.variant.unwrap();
const CatalogModelSchema = z.object({
  id: ModelIdSchema,
  context_length: z.number().int().positive(),
  max_completion_tokens: z.number().int().positive().nullish(),
  top_provider: z
    .object({ max_completion_tokens: z.number().int().positive().nullish() })
    .optional(),
  supported_parameters: z.array(z.string()).optional(),
  opencode: z
    .object({
      ai_sdk_provider: ProviderSchema.optional(),
      variants: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export function validateIsolateReviewInference(value: unknown): IsolateReviewInference {
  const inference = InferenceSchema.parse(value);
  const { modelId, provider, thinkingEffort, variant, reasoningSupported } = inference;
  if ((thinkingEffort === null) !== (variant === null)) {
    throw new Error('A selected thinking variant must have resolved settings');
  }
  if (modelId.startsWith('kilo-auto/') && thinkingEffort !== null) {
    throw new Error('Auto models control their own thinking settings');
  }
  if (
    modelId.toLowerCase().startsWith('kilo-auto/') &&
    (inference.temperature !== undefined || inference.topP !== undefined)
  ) {
    throw new Error('Auto models control their own sampling settings');
  }
  const reasoning = variant?.reasoning;
  const verbosity = variant?.verbosity;
  if (
    (reasoning?.enabled === true && reasoning.effort === 'none') ||
    (reasoning?.enabled === false && reasoning.effort !== undefined && reasoning.effort !== 'none')
  ) {
    throw new Error('Contradictory thinking settings');
  }
  if (reasoning && !reasoningSupported) {
    throw new Error('The model does not advertise reasoning support');
  }
  if (provider === 'anthropic') {
    if (reasoning?.effort !== undefined && reasoning.enabled === undefined) {
      throw new Error('Anthropic reasoning requires an explicit enabled setting');
    }
    if (reasoning?.effort && reasoning.effort !== 'none' && reasoning.effort !== verbosity) {
      throw new Error('Anthropic effort must be represented by catalog verbosity');
    }
  }
  if (
    (provider === 'openai' || provider === 'openai-compatible') &&
    reasoning?.enabled !== undefined &&
    reasoning.effort === undefined
  ) {
    throw new Error('This protocol requires a catalog reasoning effort');
  }
  if (provider === 'openai' && (verbosity === 'xhigh' || verbosity === 'max')) {
    throw new Error('Responses does not support this text verbosity');
  }
  return inference;
}

export function resolveKiloGatewayUrl(gatewayUrl: string | undefined): string {
  const url = new URL(gatewayUrl?.trim() || DEFAULT_KILO_GATEWAY_URL);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid Kilo gateway URL');
  }
  return url.toString().replace(/\/+$/, '');
}

export function resolveIsolateReviewInferenceFromCatalog(
  value: unknown,
  thinkingEffort: string | null = null
): IsolateReviewInference {
  const model = CatalogModelSchema.parse(value);
  const effort = ThinkingEffortSchema.parse(thinkingEffort);
  if (model.id.startsWith('kilo-auto/') && effort !== null) {
    throw new Error('Auto models control their own thinking settings');
  }
  if (model.supported_parameters && !model.supported_parameters.includes('tools')) {
    throw new Error('The model does not support review tools');
  }
  const variants = model.opencode?.variants;
  if (effort !== null && (!variants || !Object.hasOwn(variants, effort))) {
    throw new Error('Unknown thinking variant for this model');
  }
  const normalizedModelId = model.id.toLowerCase();
  const isQwen = !normalizedModelId.startsWith('kilo-auto/') && normalizedModelId.includes('qwen');
  return validateIsolateReviewInference({
    modelId: model.id,
    provider: model.opencode?.ai_sdk_provider ?? 'openrouter',
    thinkingEffort: effort,
    variant: effort === null ? null : VariantSchema.parse(variants?.[effort]),
    reasoningSupported: model.supported_parameters?.includes('reasoning') ?? false,
    ...(isQwen &&
    !normalizedModelId.includes('north-mini-code') &&
    model.supported_parameters?.includes('temperature')
      ? { temperature: 0.55 }
      : {}),
    ...(isQwen && model.supported_parameters?.includes('top_p') ? { topP: 1 } : {}),
    maxOutputTokens: Math.min(
      model.top_provider?.max_completion_tokens ??
        model.max_completion_tokens ??
        Math.ceil(model.context_length * 0.2),
      MAX_OUTPUT_TOKENS
    ),
  });
}

async function readCatalog(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('The model catalog response is empty');
  const reader = new ReadableStreamDefaultReader<Uint8Array>(response.body);
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new Error('The model catalog exceeds the response limit');
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    try {
      return JSON.parse(chunks.join(''));
    } catch {
      throw new Error('Invalid model catalog response');
    }
  } finally {
    reader.releaseLock();
  }
}

export async function resolveIsolateReviewInference(options: {
  kiloToken: string;
  organizationId?: string;
  model?: string;
  thinkingEffort?: string | null;
  gatewayUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<IsolateReviewInference> {
  const modelId = ModelIdSchema.parse(options.model ?? DEFAULT_MODEL);
  const effort = ThinkingEffortSchema.parse(options.thinkingEffort ?? null);
  if (modelId.startsWith('kilo-auto/') && effort !== null) {
    throw new Error('Auto models control their own thinking settings');
  }
  if (!options.kiloToken.trim()) throw new Error('An authenticated catalog request is required');
  const baseURL = resolveKiloGatewayUrl(options.gatewayUrl);
  const organizationId = z.string().min(1).max(256).optional().parse(options.organizationId);
  const url = organizationId
    ? new URL(`/api/organizations/${encodeURIComponent(organizationId)}/models`, baseURL).toString()
    : `${baseURL}/models`;
  const response = await (options.fetchImpl ?? globalThis.fetch)(url, {
    headers: {
      Authorization: `Bearer ${options.kiloToken}`,
      'User-Agent': 'kilo-isolate-review',
      ...(organizationId ? { 'X-KiloCode-OrganizationId': organizationId } : {}),
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Model catalog request failed (${response.status})`);
  }
  const catalog = z
    .object({ data: z.array(z.object({ id: z.string() }).passthrough()) })
    .parse(await readCatalog(response));
  const model = catalog.data.find(entry => entry.id === modelId);
  if (!model) throw new Error('The model is not available in the authenticated catalog');
  return resolveIsolateReviewInferenceFromCatalog(model, effort);
}

export function cleanStatelessResponsesBody(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') throw new Error('Expected a JSON Responses request');
  const request = z
    .object({ store: z.literal(false), input: z.array(z.unknown()) })
    .passthrough()
    .parse(JSON.parse(body));
  return JSON.stringify({
    ...request,
    input: request.input.flatMap(item => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return [item];
      if ('type' in item && item.type === 'item_reference') return [];
      const cleaned = { ...item };
      if ('id' in cleaned) delete cleaned.id;
      return [cleaned];
    }),
  });
}

const responsesToolMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  transformParams: async ({ params }) => ({
    ...params,
    tools: params.tools?.map(tool =>
      tool.type === 'function' ? { ...tool, strict: tool.strict ?? false } : tool
    ),
  }),
};

const openRouterReasoningMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  transformParams: async ({ params }) => ({
    ...params,
    prompt: params.prompt.map(message => {
      if (
        message.role !== 'assistant' ||
        message.providerOptions?.openrouter?.reasoning_details !== undefined
      ) {
        return message;
      }
      const parts = [
        ...message.content.filter(part => part.type === 'tool-call'),
        ...message.content.filter(part => part.type === 'reasoning'),
      ];
      const details = parts.find(part =>
        Array.isArray(part.providerOptions?.openrouter?.reasoning_details)
      )?.providerOptions?.openrouter?.reasoning_details;
      if (details === undefined) return message;
      return {
        ...message,
        providerOptions: {
          ...message.providerOptions,
          openrouter: { ...message.providerOptions?.openrouter, reasoning_details: details },
        },
      };
    }),
  }),
};

export function createKiloGatewayModel(options: {
  runId: string;
  kiloToken: string;
  organizationId?: string;
  model?: string;
  fetchImpl?: typeof globalThis.fetch;
  gatewayUrl?: string;
  inference?: IsolateReviewInference;
  sessionId?: string;
  parentSessionId?: string;
  mode?: 'code' | 'general' | 'explore';
  onRequestId?: (id: string) => void | Promise<void>;
}) {
  const inference = validateIsolateReviewInference(
    options.inference === undefined
      ? {
          modelId: options.model ?? DEFAULT_MODEL,
          provider: 'openrouter',
          thinkingEffort: null,
          variant: null,
          reasoningSupported: false,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        }
      : options.inference
  );
  if (options.model !== undefined && options.model !== inference.modelId) {
    throw new Error('The requested model does not match the resolved inference settings');
  }
  if (!options.kiloToken.trim()) throw new Error('A Kilo inference token is required');
  const sessionId = options.sessionId ?? options.runId;
  const mode = z.enum(['code', 'general', 'explore']).parse(options.mode ?? 'code');
  const headers = {
    'User-Agent': 'kilo-isolate-review',
    'x-kilocode-feature': 'code-review',
    'x-kilocode-mode': mode,
    'x-kilocode-taskid': sessionId,
    'x-kilo-session': sessionId,
    ...(options.parentSessionId ? { 'x-kilocode-parent-taskid': options.parentSessionId } : {}),
    ...(options.organizationId ? { 'X-KiloCode-OrganizationId': options.organizationId } : {}),
  };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const providerFetch: typeof globalThis.fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const body =
      inference.provider === 'openai' ? cleanStatelessResponsesBody(init?.body) : init?.body;
    const requestId = crypto.randomUUID();
    await options.onRequestId?.(requestId);
    init?.signal?.throwIfAborted();
    const requestHeaders = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, value);
    requestHeaders.set('Authorization', `Bearer ${options.kiloToken}`);
    requestHeaders.set('x-kilo-request', requestId);
    return fetchImpl(input, {
      ...init,
      body,
      redirect: 'manual',
      headers: requestHeaders,
    });
  };
  const common = {
    baseURL: resolveKiloGatewayUrl(options.gatewayUrl),
    headers,
    fetch: providerFetch,
  };
  const reasoning = inference.variant?.reasoning;
  const verbosity = inference.variant?.verbosity;
  const settings: Parameters<typeof defaultSettingsMiddleware>[0]['settings'] = {
    maxOutputTokens: inference.maxOutputTokens,
    temperature: inference.temperature,
    topP: inference.topP,
  };
  let model: Parameters<typeof wrapLanguageModel>[0]['model'];
  switch (inference.provider) {
    case 'anthropic':
      model = createAnthropic({ ...common, authToken: options.kiloToken })(inference.modelId);
      settings.providerOptions = {
        anthropic: {
          ...(reasoning?.enabled !== undefined
            ? { thinking: { type: reasoning.enabled ? 'adaptive' : 'disabled' } }
            : {}),
          ...(verbosity ? { effort: verbosity } : {}),
        },
      };
      break;
    case 'openai':
      model = createOpenAI({ ...common, apiKey: options.kiloToken }).responses(inference.modelId);
      settings.providerOptions = {
        openai: {
          store: false,
          forceReasoning: inference.reasoningSupported,
          ...(inference.reasoningSupported ? { include: ['reasoning.encrypted_content'] } : {}),
          ...(reasoning?.effort ? { reasoningEffort: reasoning.effort } : {}),
          ...(reasoning?.effort && reasoning.effort !== 'none' ? { reasoningSummary: 'auto' } : {}),
          ...(verbosity ? { textVerbosity: verbosity } : {}),
        },
      };
      break;
    case 'openai-compatible':
      model = createOpenAICompatible({
        ...common,
        name: 'kilo-gateway',
        apiKey: options.kiloToken,
      })(inference.modelId);
      settings.providerOptions = {
        kiloGateway: {
          ...(reasoning?.effort ? { reasoningEffort: reasoning.effort } : {}),
          ...(verbosity ? { textVerbosity: verbosity } : {}),
        },
      };
      break;
    case 'openrouter':
      model = createOpenRouter({ ...common, apiKey: options.kiloToken })(inference.modelId);
      settings.providerOptions = {
        openrouter: {
          usage: { include: true },
          ...(reasoning ? { reasoning } : {}),
          ...(verbosity ? { verbosity } : {}),
        },
      };
      break;
  }
  return wrapLanguageModel({
    model,
    middleware: [
      defaultSettingsMiddleware({ settings }),
      ...(inference.provider === 'openai' ? [responsesToolMiddleware] : []),
      ...(inference.provider === 'openrouter' ? [openRouterReasoningMiddleware] : []),
    ],
  });
}

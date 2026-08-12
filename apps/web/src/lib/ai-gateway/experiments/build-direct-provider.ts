import { addCacheBreakpoints } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { CustomLlmApiConfig } from '@kilocode/db';
import type {
  GatewayChatApiKind,
  Provider,
  TransformRequestContext,
} from '@/lib/ai-gateway/providers/types';

/**
 * Plain in-memory shape: a `CustomLlmApiConfig` merged with the decrypted
 * partner-issued api key.
 *
 * `pickModelExperimentVariant` decrypts the chosen
 * `model_experiment_variant_version.encrypted_api_key` and merges the
 * plaintext with the upstream blob for the outbound provider request. The
 * plaintext NEVER touches Postgres, Redis, or any tRPC response.
 */
export type ResolvedExperimentUpstream = CustomLlmApiConfig & { api_key: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setPropertyPath(target: Record<string, unknown>, path: string, value: string) {
  const segments = path.split('.');
  const finalSegment = segments.at(-1);
  if (!finalSegment) {
    return;
  }

  let current = target;

  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (isRecord(existing)) {
      current = existing;
      continue;
    }

    const nested: Record<string, unknown> = {};
    current[segment] = nested;
    current = nested;
  }

  current[finalSegment] = value;
}

const GEMINI_THOUGHT_CONTENT_MAPPING = 'extra_content.google.thought';
const GEMINI_THOUGHT_SIGNATURE_MAPPING = 'extra_content.google.thought_signature';

function mapGeminiThoughtSignatures(context: TransformRequestContext) {
  if (context.request.kind !== 'chat_completions') {
    return;
  }

  for (const message of context.request.body.messages) {
    if (!isRecord(message)) {
      continue;
    }

    delete message.thoughtSignature;

    if (!Array.isArray(message.tool_calls)) {
      continue;
    }

    for (const toolCall of message.tool_calls) {
      if (!isRecord(toolCall)) {
        continue;
      }

      const signature = toolCall.thoughtSignature;
      delete toolCall.thoughtSignature;
      if (typeof signature === 'string') {
        setPropertyPath(toolCall, GEMINI_THOUGHT_SIGNATURE_MAPPING, signature);
      }
    }
  }
}

function applyGeminiReasoningTransform(context: TransformRequestContext, reasoningEffort: unknown) {
  if (context.request.kind !== 'chat_completions') {
    return;
  }

  const extra = context.request.body as typeof context.request.body & { google?: unknown };
  delete extra.reasoning_effort;

  if (reasoningEffort !== 'none') {
    const existingGoogle = isRecord(extra.google) ? extra.google : {};
    extra.google = {
      ...existingGoogle,
      thinking_config: {
        ...(reasoningEffort !== undefined ? { thinking_level: reasoningEffort } : {}),
        include_thoughts: true,
      },
    };
  }

  mapGeminiThoughtSignatures(context);
}

function renameJsonRefProperties(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.reduce<boolean>(
      (changed, item) => renameJsonRefProperties(item) || changed,
      false
    );
  }

  if (!isRecord(value)) {
    return false;
  }

  let changed = false;
  for (const [key, nestedValue] of Object.entries(value)) {
    changed = renameJsonRefProperties(nestedValue) || changed;
    if (key === '$ref') {
      delete value.$ref;
      value._ref = nestedValue;
      changed = true;
    }
  }
  return changed;
}

function sanitizeJsonRefContent(content: string): string {
  try {
    const result: unknown = JSON.parse(content);
    return renameJsonRefProperties(result) ? JSON.stringify(result) : content;
  } catch {
    return content;
  }
}

function sanitizeJsonRefToolResults(context: TransformRequestContext) {
  if (context.request.kind !== 'chat_completions') {
    return;
  }

  for (const message of context.request.body.messages) {
    if (message.role !== 'tool') {
      continue;
    }

    if (typeof message.content === 'string') {
      message.content = sanitizeJsonRefContent(message.content);
    } else {
      for (const part of message.content) {
        if (part.type === 'text') {
          part.text = sanitizeJsonRefContent(part.text);
        }
      }
    }
  }
}

/**
 * Builds a `Provider` that points directly at a partner-issued upstream.
 *
 * Used by both the experiment routing path and the existing
 * `kilo-internal/...` (custom_llm2) path. The caller supplies supported chat
 * APIs separately from the shared upstream API config.
 *
 * Direct traffic goes to `apiUrl` — OpenRouter and Vercel are never
 * contacted. The route layer is responsible for not applying provider
 * pinning or kilo-exclusive model rewrites on top of this provider.
 */
export function buildDirectProvider(
  id: 'custom' | 'experiment',
  supportedChatApis: ReadonlyArray<GatewayChatApiKind>,
  upstream: ResolvedExperimentUpstream
): Provider {
  return {
    id,
    apiUrl: upstream.base_url,
    apiKey: upstream.api_key,
    supportedChatApis,
    responseTransforms: upstream.use_gemini_reasoning_transform
      ? { thoughtContentMapping: GEMINI_THOUGHT_CONTENT_MAPPING }
      : null,
    async transformRequest(context) {
      const useGeminiReasoning = Boolean(upstream.use_gemini_reasoning_transform);
      const reasoningEffort =
        useGeminiReasoning && context.request.kind === 'chat_completions'
          ? context.request.body.reasoning_effort
          : undefined;

      if (upstream.remove_from_body) {
        const body = context.request.body as Record<string, unknown>;
        for (const key of upstream.remove_from_body) {
          delete body[key];
        }
      }
      Object.assign(context.request.body, upstream.extra_body ?? {});
      if (upstream.extra_headers) {
        Object.assign(context.extraHeaders, upstream.extra_headers);
      }
      context.request.body.model = upstream.internal_id;
      if (upstream.add_cache_breakpoints) {
        addCacheBreakpoints(context.request);
      }
      if (useGeminiReasoning) {
        applyGeminiReasoningTransform(context, reasoningEffort);
      }
      if (upstream.sanitize_ref_fields) {
        sanitizeJsonRefToolResults(context);
      }
    },
  };
}

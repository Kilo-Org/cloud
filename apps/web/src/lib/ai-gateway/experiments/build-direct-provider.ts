import { addCacheBreakpoints } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import { ReasoningFormat } from '@/lib/ai-gateway/custom-llm/format';
import { ReasoningDetailType } from '@/lib/ai-gateway/custom-llm/reasoning-details';
import type { CustomLlmApiConfig } from '@kilocode/db';
import {
  ReasoningDetailsTransform,
  type GatewayChatApiKind,
  type Provider,
  type TransformRequestContext,
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

function setGeminiThoughtSignature(value: Record<string, unknown>, signature: string) {
  const extraContent = isRecord(value.extra_content) ? value.extra_content : {};
  const google = isRecord(extraContent.google) ? extraContent.google : {};
  value.extra_content = {
    ...extraContent,
    google: {
      ...google,
      thought_signature: signature,
    },
  };
}

function mapGeminiReasoningDetails(context: TransformRequestContext) {
  if (context.request.kind !== 'chat_completions') {
    return;
  }

  for (const message of context.request.body.messages) {
    if (!isRecord(message)) {
      continue;
    }

    delete message.thoughtSignature;

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
    for (const toolCall of toolCalls) {
      const legacySignature = toolCall.thoughtSignature;
      delete toolCall.thoughtSignature;
      if (typeof legacySignature === 'string') {
        setGeminiThoughtSignature(toolCall, legacySignature);
      }
    }

    const reasoningDetails = message.reasoning_details;
    delete message.reasoning_details;
    if (!Array.isArray(reasoningDetails)) {
      continue;
    }

    for (const detail of reasoningDetails) {
      if (
        !isRecord(detail) ||
        detail.type !== ReasoningDetailType.Encrypted ||
        typeof detail.data !== 'string' ||
        detail.format !== ReasoningFormat.GoogleGeminiV1
      ) {
        continue;
      }

      const toolCall =
        typeof detail.id === 'string'
          ? toolCalls.find(candidate => candidate.id === detail.id)
          : toolCalls[0];
      setGeminiThoughtSignature(toolCall ?? message, detail.data);
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

  mapGeminiReasoningDetails(context);
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
    apiUrlOverrides: {},
    apiKey: upstream.api_key,
    supportedChatApis,
    responseTransforms: upstream.use_gemini_reasoning_transform
      ? ReasoningDetailsTransform.GeminiThought
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

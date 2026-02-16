/**
 * Bidirectional conversion between reasoning_details and AI SDK provider metadata.
 *
 * Provider metadata shapes (from the AI SDK source):
 *   Anthropic – { anthropic: { signature?, redactedData? } }
 *   OpenAI    – { openai:    { itemId, reasoningEncryptedContent? } }
 *   xAI       – { xai:       { itemId?, reasoningEncryptedContent? } }
 *   Google    – { google:    { thoughtSignature? } }
 */

import { ReasoningFormat } from './format';
import { ReasoningDetailType } from './reasoning-details';
import type {
  ReasoningDetailUnion,
  ReasoningDetailText,
  ReasoningDetailEncrypted,
} from './reasoning-details';

type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];
type AiSdkProviderOptions = Record<string, Record<string, JsonValue>>;

/** Mirrors `ReasoningPart` from `@ai-sdk/provider-utils` without pulling in that dependency. */
export type AiSdkReasoningPart = {
  type: 'reasoning';
  text: string;
  providerOptions?: AiSdkProviderOptions;
};

function detailToAiSdkPart(detail: ReasoningDetailUnion): AiSdkReasoningPart | null {
  switch (detail.type) {
    case ReasoningDetailType.Text: {
      const text = detail.text ?? '';
      const opts = buildTextProviderOptions(detail);
      return {
        type: 'reasoning',
        text,
        ...(opts ? { providerOptions: opts } : {}),
      };
    }

    case ReasoningDetailType.Encrypted: {
      const opts = buildEncryptedProviderOptions(detail);
      return {
        type: 'reasoning',
        text: '',
        ...(opts ? { providerOptions: opts } : {}),
      };
    }

    case ReasoningDetailType.Summary:
      return { type: 'reasoning', text: detail.summary };
  }
}

function buildTextProviderOptions(detail: ReasoningDetailText): AiSdkProviderOptions | null {
  switch (detail.format) {
    case ReasoningFormat.AnthropicClaudeV1: {
      if (!detail.signature) return null;
      return { anthropic: { signature: detail.signature } };
    }
    case ReasoningFormat.OpenAIResponsesV1: {
      if (!detail.id) return null;
      return { openai: { itemId: detail.id } };
    }
    case ReasoningFormat.XAIResponsesV1: {
      if (!detail.id) return null;
      return { xai: { itemId: detail.id } };
    }
    case ReasoningFormat.GoogleGeminiV1: {
      if (!detail.signature) return null;
      return { google: { thoughtSignature: detail.signature } };
    }
    default:
      return null;
  }
}

function buildEncryptedProviderOptions(
  detail: ReasoningDetailEncrypted
): AiSdkProviderOptions | null {
  switch (detail.format) {
    case ReasoningFormat.AnthropicClaudeV1:
      return { anthropic: { redactedData: detail.data } };
    case ReasoningFormat.OpenAIResponsesV1: {
      const inner: Record<string, JsonValue> = { reasoningEncryptedContent: detail.data };
      if (detail.id) inner.itemId = detail.id;
      return { openai: inner };
    }
    case ReasoningFormat.XAIResponsesV1: {
      const inner: Record<string, JsonValue> = { reasoningEncryptedContent: detail.data };
      if (detail.id) inner.itemId = detail.id;
      return { xai: inner };
    }
    default:
      // Google and unknown formats don't have an encrypted reasoning concept
      return null;
  }
}

/**
 * For OpenAI/xAI formats, encrypted details sharing an `id` with a text detail
 * are merged onto the text part (the AI SDK groups by itemId).
 */
export function reasoningDetailsToAiSdkParts(
  details: ReasoningDetailUnion[]
): AiSdkReasoningPart[] {
  // Check if any details use OpenAI/xAI format (which need merge logic)
  const needsMerge = details.some(
    d =>
      d.format === ReasoningFormat.OpenAIResponsesV1 || d.format === ReasoningFormat.XAIResponsesV1
  );

  if (needsMerge) {
    return mergeEncryptedIntoTextParts(details);
  }

  const parts: AiSdkReasoningPart[] = [];
  for (const detail of details) {
    const part = detailToAiSdkPart(detail);
    if (part) parts.push(part);
  }
  return parts;
}

const FORMAT_TO_PROVIDER_KEY: Partial<Record<ReasoningFormat, string>> = {
  [ReasoningFormat.AnthropicClaudeV1]: 'anthropic',
  [ReasoningFormat.OpenAIResponsesV1]: 'openai',
  [ReasoningFormat.XAIResponsesV1]: 'xai',
  [ReasoningFormat.GoogleGeminiV1]: 'google',
};

function mergeEncryptedIntoTextParts(details: ReasoningDetailUnion[]): AiSdkReasoningPart[] {
  const encryptedById = new Map<string, string>();
  for (const d of details) {
    if (d.type === ReasoningDetailType.Encrypted && d.id) {
      encryptedById.set(d.id, d.data);
    }
  }

  const usedEncryptedIds = new Set<string>();
  const parts: AiSdkReasoningPart[] = [];

  for (const detail of details) {
    if (detail.type === ReasoningDetailType.Encrypted) continue;

    const part = detailToAiSdkPart(detail);
    if (!part) continue;

    if (detail.type === ReasoningDetailType.Text && detail.id) {
      const encryptedData = encryptedById.get(detail.id);
      if (encryptedData) {
        const providerKey = detail.format ? FORMAT_TO_PROVIDER_KEY[detail.format] : undefined;
        if (providerKey) {
          const existing = (part.providerOptions?.[providerKey] ?? {}) satisfies Record<
            string,
            JsonValue
          >;
          part.providerOptions = {
            ...part.providerOptions,
            [providerKey]: { ...existing, reasoningEncryptedContent: encryptedData },
          };
          usedEncryptedIds.add(detail.id);
        }
      }
    }

    parts.push(part);
  }

  for (const detail of details) {
    if (detail.type !== ReasoningDetailType.Encrypted) continue;
    if (detail.id && usedEncryptedIds.has(detail.id)) continue;
    const part = detailToAiSdkPart(detail);
    if (part) parts.push(part);
  }

  return parts;
}

type ProviderMetadata = Record<string, Record<string, unknown>> | undefined;

export function extractSignature(meta: ProviderMetadata): string | null {
  if (!meta) return null;
  const anthropicSig = meta.anthropic?.signature;
  if (typeof anthropicSig === 'string') return anthropicSig;
  const googleSig = meta.google?.thoughtSignature;
  if (typeof googleSig === 'string') return googleSig;
  const vertexSig = meta.vertex?.thoughtSignature;
  if (typeof vertexSig === 'string') return vertexSig;
  return null;
}

export function extractEncryptedData(meta: ProviderMetadata): string | null {
  if (!meta) return null;
  const anthropic = meta.anthropic?.redactedData;
  if (typeof anthropic === 'string') return anthropic;
  const openai = meta.openai?.reasoningEncryptedContent;
  if (typeof openai === 'string') return openai;
  const xai = meta.xai?.reasoningEncryptedContent;
  if (typeof xai === 'string') return xai;
  return null;
}

export function extractItemId(meta: ProviderMetadata): string | null {
  if (!meta) return null;
  const openaiId = meta.openai?.itemId;
  if (typeof openaiId === 'string') return openaiId;
  const xaiId = meta.xai?.itemId;
  if (typeof xaiId === 'string') return xaiId;
  return null;
}

export function extractFormat(meta: ProviderMetadata): ReasoningFormat | null {
  if (!meta) return null;
  if (meta.anthropic) return ReasoningFormat.AnthropicClaudeV1;
  if (meta.openai) return ReasoningFormat.OpenAIResponsesV1;
  if (meta.xai) return ReasoningFormat.XAIResponsesV1;
  if (meta.google || meta.vertex) return ReasoningFormat.GoogleGeminiV1;
  return null;
}

export function reasoningOutputToDetails(
  reasoning: ReadonlyArray<{ type: 'reasoning'; text: string; providerMetadata?: ProviderMetadata }>
): ReasoningDetailUnion[] {
  const details: ReasoningDetailUnion[] = [];

  for (const part of reasoning) {
    const signature = extractSignature(part.providerMetadata);
    const encryptedData = extractEncryptedData(part.providerMetadata);
    const itemId = extractItemId(part.providerMetadata);
    const format = extractFormat(part.providerMetadata);
    const optionalFields = {
      ...(itemId ? { id: itemId } : {}),
      ...(format ? { format } : {}),
    };

    if (part.text) {
      details.push({
        type: ReasoningDetailType.Text,
        text: part.text,
        ...(signature ? { signature } : {}),
        ...optionalFields,
      });
    }

    if (encryptedData) {
      details.push({
        type: ReasoningDetailType.Encrypted,
        data: encryptedData,
        ...optionalFields,
      });
    }
  }

  return details;
}

/**
 * Bidirectional conversion between reasoning_details and AI SDK provider metadata.
 *
 * Each AI SDK provider stores encrypted reasoning data and signatures in its own
 * provider-specific format.  This module maps between those formats and the
 * provider-agnostic `ReasoningDetailUnion` schema used in the OpenRouter
 * chat-completions wire format.
 *
 * Provider metadata shapes (from the AI SDK source):
 *
 *   Anthropic  – { anthropic: { signature?, redactedData? } }
 *   OpenAI     – { openai:    { itemId, reasoningEncryptedContent? } }
 *   xAI        – { xai:       { itemId?, reasoningEncryptedContent? } }
 *   Google     – { google:    { thoughtSignature? } }
 *
 * The `format` field on each reasoning detail indicates which provider format
 * was used, enabling correct translation without relying on the model name.
 */

import { ReasoningFormat } from './format';
import { ReasoningDetailType } from './reasoning-details';
import type {
  ReasoningDetailUnion,
  ReasoningDetailText,
  ReasoningDetailEncrypted,
} from './reasoning-details';

// ---------------------------------------------------------------------------
// JSON-compatible types mirroring the AI SDK's ProviderOptions
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];
type AiSdkProviderOptions = Record<string, Record<string, JsonValue>>;

// ---------------------------------------------------------------------------
// INPUT: reasoning_details → AI SDK reasoning content parts
// ---------------------------------------------------------------------------

/**
 * The shape of an AI SDK reasoning content part inside a ModelMessage.
 *
 * This mirrors the `ReasoningPart` type from `@ai-sdk/provider-utils` but is
 * kept here to avoid pulling in that dependency purely for a type.
 */
export type AiSdkReasoningPart = {
  type: 'reasoning';
  text: string;
  providerOptions?: AiSdkProviderOptions;
};

/**
 * Convert a single `ReasoningDetailUnion` to an AI SDK reasoning content part,
 * populating the correct `providerOptions` based on the detail's `format` field.
 */
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

/** Map from ReasoningFormat to the provider key used in AI SDK providerOptions. */
const FORMAT_TO_PROVIDER_KEY: Partial<Record<ReasoningFormat, string>> = {
  [ReasoningFormat.AnthropicClaudeV1]: 'anthropic',
  [ReasoningFormat.OpenAIResponsesV1]: 'openai',
  [ReasoningFormat.XAIResponsesV1]: 'xai',
  [ReasoningFormat.GoogleGeminiV1]: 'google',
};

/**
 * Convert an array of reasoning_details into AI SDK reasoning content parts
 * with the correct providerOptions based on each detail's `format` field.
 *
 * For OpenAI/xAI formats, when an encrypted detail shares an `id` with a text
 * detail, the encrypted content is merged onto the text part (the AI SDK
 * provider layer groups by itemId and combines summary + encrypted_content).
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

/**
 * For OpenAI/xAI formats: merge encrypted details that share an id with a text
 * detail into a single AI SDK reasoning part carrying both the summary text and
 * the `reasoningEncryptedContent` in providerOptions.
 */
function mergeEncryptedIntoTextParts(details: ReasoningDetailUnion[]): AiSdkReasoningPart[] {
  // Build a map of id → encrypted data
  const encryptedById = new Map<string, string>();
  for (const d of details) {
    if (d.type === ReasoningDetailType.Encrypted && d.id) {
      encryptedById.set(d.id, d.data);
    }
  }

  const usedEncryptedIds = new Set<string>();
  const parts: AiSdkReasoningPart[] = [];

  for (const detail of details) {
    if (detail.type === ReasoningDetailType.Encrypted) continue; // handled below or merged

    const part = detailToAiSdkPart(detail);
    if (!part) continue;

    // If this text detail has an id matching an encrypted detail, attach encrypted content
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

  // Emit standalone encrypted details that weren't merged
  for (const detail of details) {
    if (detail.type !== ReasoningDetailType.Encrypted) continue;
    if (detail.id && usedEncryptedIds.has(detail.id)) continue;
    const part = detailToAiSdkPart(detail);
    if (part) parts.push(part);
  }

  return parts;
}

// ---------------------------------------------------------------------------
// OUTPUT: AI SDK providerMetadata → reasoning_details
// ---------------------------------------------------------------------------

/**
 * Metadata shape as it appears on `providerMetadata` in AI SDK stream parts
 * and `ReasoningOutput`.
 */
type ProviderMetadata = Record<string, Record<string, unknown>> | undefined;

/**
 * Extract a signature string from AI SDK providerMetadata.
 *
 * Anthropic: `providerMetadata.anthropic.signature`
 * Google:    `providerMetadata.google.thoughtSignature`
 */
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

/**
 * Extract encrypted/redacted reasoning data from AI SDK providerMetadata.
 *
 * Anthropic: `providerMetadata.anthropic.redactedData`
 * OpenAI:    `providerMetadata.openai.reasoningEncryptedContent`
 * xAI:       `providerMetadata.xai.reasoningEncryptedContent`
 */
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

/**
 * Extract an itemId from AI SDK providerMetadata.
 *
 * OpenAI: `providerMetadata.openai.itemId`
 * xAI:    `providerMetadata.xai.itemId`
 */
export function extractItemId(meta: ProviderMetadata): string | null {
  if (!meta) return null;
  const openaiId = meta.openai?.itemId;
  if (typeof openaiId === 'string') return openaiId;
  const xaiId = meta.xai?.itemId;
  if (typeof xaiId === 'string') return xaiId;
  return null;
}

/**
 * Determine the ReasoningFormat from AI SDK providerMetadata based on which
 * provider key is present.
 */
export function extractFormat(meta: ProviderMetadata): ReasoningFormat | null {
  if (!meta) return null;
  if (meta.anthropic) return ReasoningFormat.AnthropicClaudeV1;
  if (meta.openai) return ReasoningFormat.OpenAIResponsesV1;
  if (meta.xai) return ReasoningFormat.XAIResponsesV1;
  if (meta.google || meta.vertex) return ReasoningFormat.GoogleGeminiV1;
  return null;
}

/**
 * Convert a single AI SDK reasoning output (from `generateText().reasoning`)
 * into one or more `ReasoningDetailUnion` entries.
 */
export function reasoningOutputToDetails(
  reasoning: ReadonlyArray<{ type: 'reasoning'; text: string; providerMetadata?: ProviderMetadata }>
): ReasoningDetailUnion[] {
  const details: ReasoningDetailUnion[] = [];

  for (const part of reasoning) {
    const signature = extractSignature(part.providerMetadata);
    const encryptedData = extractEncryptedData(part.providerMetadata);
    const itemId = extractItemId(part.providerMetadata);
    const format = extractFormat(part.providerMetadata);

    // Anthropic redacted_thinking: empty text with redactedData
    if (encryptedData && !part.text) {
      details.push({
        type: ReasoningDetailType.Encrypted,
        data: encryptedData,
        ...(itemId ? { id: itemId } : {}),
        ...(format ? { format } : {}),
      });
      continue;
    }

    // Normal reasoning text (possibly with signature)
    if (part.text) {
      details.push({
        type: ReasoningDetailType.Text,
        text: part.text,
        ...(signature ? { signature } : {}),
        ...(itemId ? { id: itemId } : {}),
        ...(format ? { format } : {}),
      });
    }

    // OpenAI/xAI: encrypted content alongside summary text
    if (encryptedData && part.text) {
      details.push({
        type: ReasoningDetailType.Encrypted,
        data: encryptedData,
        ...(itemId ? { id: itemId } : {}),
        ...(format ? { format } : {}),
      });
    }
  }

  return details;
}

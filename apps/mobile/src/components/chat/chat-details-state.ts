import { calculateContextUsagePercentage } from '@kilocode/cloud-agent-sdk/context-usage';
import { type ModelUsage } from '@kilocode/harness-sdk';
import { useState } from 'react';

import { chatTargetKind, decodeBackendTarget, decodeLocalTarget } from '@/lib/chat/backend-target';
import { type StoredChatBackend } from '@/lib/chat/backend-store';
import { type ChatUsage } from '@/lib/chat/chat-usage';
import { type ChatRecord } from '@/lib/chat/store';
import { type ModelPricing } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type SessionContextInfo } from '@/lib/session-context-info';

import { type McpSettings } from './mcp-settings-sheet';

/**
 * What one model cost a chat.
 *
 * `billed` is the gateway's own figure for what it charged. `estimated` is the
 * catalog's list price times the tokens, for a model whose answers came with no
 * figure: a free model, or a model with a custom price. An on-device model costs
 * nothing, and a model with neither a figure nor a price is not known — a
 * custom backend reports neither, and no price is made up for it.
 */
export type ModelCost =
  | { readonly kind: 'billed'; readonly usd: number }
  | { readonly kind: 'estimated'; readonly usd: number }
  | { readonly kind: 'onDevice' }
  | { readonly kind: 'unknown' };

/** What the whole chat cost, from what each of its models cost. */
export type ChatCost =
  | { readonly kind: 'none' }
  | { readonly kind: 'onDevice' }
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'known';
      readonly usd: number;
      /** A list price stands in for some of it. */
      readonly estimated: boolean;
      /** Some of the chat ran on a model whose cost is not known, and is left out. */
      readonly partial: boolean;
    };

const perToken = (price: string | undefined): number | undefined => {
  const value = price === undefined ? Number.NaN : Number(price);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

/**
 * The list price of what a model used. A cache price the catalog leaves out is
 * charged at the input price, which is the most a provider charges for it.
 */
export function estimatedCost(
  usage: ModelUsage,
  pricing: ModelPricing | undefined
): number | undefined {
  const prompt = perToken(pricing?.prompt);
  const completion = perToken(pricing?.completion);
  if (prompt === undefined || completion === undefined) {
    return undefined;
  }
  return (
    usage.inputTokens * prompt +
    usage.outputTokens * completion +
    usage.cacheReadTokens * (perToken(pricing?.input_cache_read) ?? prompt) +
    usage.cacheWriteTokens * (perToken(pricing?.input_cache_write) ?? prompt)
  );
}

export function modelCost(
  model: string,
  usage: ModelUsage,
  option: SessionModelOption | undefined
): ModelCost {
  if (chatTargetKind(model) === 'local') {
    return { kind: 'onDevice' };
  }
  if (usage.cost !== undefined) {
    return { kind: 'billed', usd: usage.cost };
  }
  const usd = estimatedCost(usage, option?.pricing);
  return usd === undefined ? { kind: 'unknown' } : { kind: 'estimated', usd };
}

export function chatCost(costs: readonly ModelCost[]): ChatCost {
  let usd = 0;
  let priced = false;
  let estimated = false;
  let unknown = false;
  for (const cost of costs) {
    if (cost.kind === 'billed' || cost.kind === 'estimated') {
      usd += cost.usd;
      priced = true;
      estimated ||= cost.kind === 'estimated';
    }
    unknown ||= cost.kind === 'unknown';
  }
  if (priced) {
    return { kind: 'known', usd, estimated, partial: unknown };
  }
  if (unknown) {
    return { kind: 'unknown' };
  }
  return costs.length === 0 ? { kind: 'none' } : { kind: 'onDevice' };
}

/** One model the chat was answered by, with what it used and what that cost. */
export type ChatModelUsage = {
  readonly model: string;
  readonly name: string;
  readonly usage: ModelUsage;
  readonly cost: ModelCost;
};

/**
 * The name a picker would show, or what the target names when the picker no
 * longer has it: a deleted backend's model, or a catalog that has not loaded.
 */
export function modelNameOf(model: string, options: readonly SessionModelOption[]): string {
  const option = options.find(one => one.id === model);
  if (option !== undefined) {
    return option.name;
  }
  try {
    return decodeBackendTarget(model)?.modelId ?? decodeLocalTarget(model)?.modelId ?? model;
  } catch {
    return model;
  }
}

export function chatModelUsages(
  usage: ChatUsage,
  options: readonly SessionModelOption[]
): readonly ChatModelUsage[] {
  return Object.entries(usage).map(([model, used]) => ({
    model,
    name: modelNameOf(model, options),
    usage: used,
    cost: modelCost(
      model,
      used,
      options.find(one => one.id === model)
    ),
  }));
}

/**
 * How full the window is: what the last call put in front of the model,
 * against the window the picker knows for the model the chat is on. Nothing
 * before the first answer, because nothing has been put in front of it yet.
 */
export function chatContextInfo(
  model: string,
  prompted: number,
  options: readonly SessionModelOption[]
): SessionContextInfo | undefined {
  if (prompted <= 0) {
    return undefined;
  }
  const contextWindow = options.find(one => one.id === model)?.contextWindow;
  return {
    contextTokens: prompted,
    providerID: chatTargetKind(model),
    modelID: model,
    contextWindow,
    percentage: calculateContextUsagePercentage(prompted, contextWindow),
  };
}

export function useChatDetails({
  model,
  record,
  modelOptions,
  backends,
  mcp,
  hasMessages,
}: {
  model: string;
  record: ChatRecord;
  modelOptions: readonly SessionModelOption[];
  backends: readonly StoredChatBackend[];
  mcp: McpSettings;
  hasMessages: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const cost = chatCost(chatModelUsages(record.usage, modelOptions).map(one => one.cost));
  return {
    metrics: {
      info: chatContextInfo(model, record.prompted, modelOptions),
      totalCostMicrodollars: cost.kind === 'known' ? Math.round(cost.usd * 1_000_000) : null,
      hasMessages,
      onPress: () => {
        setVisible(true);
      },
    },
    sheet: {
      visible,
      onClose: () => {
        setVisible(false);
      },
      model,
      record,
      modelOptions,
      backends,
      mcp,
    },
  };
}

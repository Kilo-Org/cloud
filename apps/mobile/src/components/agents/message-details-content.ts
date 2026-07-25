import { type StoredMessage } from 'cloud-agent-sdk';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { collectCopyableText } from './collect-copyable-text';
import { formatCost } from './context-usage-display';
import { resolveMessageDisplayModel } from './message-model-label';
import { friendlyModelName } from './session-model-display';

type MessageDetailsTokenRow = {
  label: string;
  value: number;
};

type MessageDetailsContent = {
  roleLabel: string;
  sentTimeLabel: string | null;
  modelLabel: string | null;
  costLabel: string | null;
  tokenRows: MessageDetailsTokenRow[] | null;
  copyableText: string | null;
};

const SENT_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * Pure projection of a StoredMessage into the details-sheet fields.
 * Unit-tested for happy / empty visibility rules; the sheet component
 * only renders this shape.
 */
export function getMessageDetailsContent(
  message: StoredMessage,
  modelOptions: SessionModelOption[]
): MessageDetailsContent {
  const roleLabel = message.info.role === 'user' ? 'User' : 'Assistant';
  const sentTimeLabel = formatMessageSentTime(message.info.time.created);
  const copyable = collectCopyableText(message);
  const copyableText = copyable.length > 0 ? copyable : null;

  if (message.info.role !== 'assistant') {
    return {
      roleLabel,
      sentTimeLabel,
      modelLabel: null,
      costLabel: null,
      tokenRows: null,
      copyableText,
    };
  }

  const resolved = resolveMessageDisplayModel(message);
  const modelLabel = resolved
    ? friendlyModelName(resolved.providerID, resolved.modelID, modelOptions)
    : null;

  const usage = getAssistantUsage(message);
  const showUsage = usage !== null && !isZeroUsage(usage);

  return {
    roleLabel,
    sentTimeLabel,
    modelLabel,
    costLabel: showUsage ? formatCost(usage.cost) : null,
    tokenRows: showUsage
      ? [
          { label: 'Input', value: usage.input },
          { label: 'Output', value: usage.output },
          { label: 'Reasoning', value: usage.reasoning },
          { label: 'Cache read', value: usage.cacheRead },
          { label: 'Cache write', value: usage.cacheWrite },
          { label: 'Total', value: usage.total },
        ]
      : null,
    copyableText,
  };
}

type AssistantUsage = {
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

function getAssistantUsage(message: StoredMessage): AssistantUsage | null {
  if (message.info.role !== 'assistant') {
    return null;
  }
  const { cost, tokens } = message.info;
  const input = tokens.input;
  const output = tokens.output;
  const reasoning = tokens.reasoning;
  const cacheRead = tokens.cache.read;
  const cacheWrite = tokens.cache.write;
  return {
    cost,
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
  };
}

function isZeroUsage(usage: AssistantUsage): boolean {
  return (
    usage.cost === 0 &&
    usage.input === 0 &&
    usage.output === 0 &&
    usage.reasoning === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0
  );
}

/** Format an epoch-ms created timestamp; null when absent/invalid. */
export function formatMessageSentTime(created: number | undefined | null): string | null {
  if (created === undefined || created === null || !Number.isFinite(created) || created <= 0) {
    return null;
  }
  return SENT_TIME_FORMATTER.format(new Date(created));
}

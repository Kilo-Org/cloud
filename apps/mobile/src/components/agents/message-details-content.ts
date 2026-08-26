import { type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { dateTimeFormat } from '@/lib/intl-cache';

import { collectCopyableText } from './collect-copyable-text';
import { formatCost } from './context-usage-display';
import { resolveMessageDisplayModel } from './message-model-label';
import { isPartStreaming } from './part-types';
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
  canSelectText: boolean;
};

/**
 * Pure projection of a StoredMessage into the details-sheet fields.
 * Unit-tested for happy / empty visibility rules; the sheet component
 * only renders this shape.
 */
export function getMessageDetailsContent(
  message: StoredMessage,
  modelOptions: SessionModelOption[]
): MessageDetailsContent {
  const roleLabel =
    message.info.role === 'user'
      ? i18n.t('agentChat.messageDetails.roleUser')
      : i18n.t('agentChat.messageDetails.roleAssistant');
  const sentTimeLabel = formatMessageSentTime(message.info.time.created);
  const copyable = collectCopyableText(message);
  const copyableText = copyable.length > 0 ? copyable : null;
  const canSelectText =
    copyableText !== null &&
    !message.parts.some(part => isPartInFlightForSelect(part, message.info.role));

  if (message.info.role !== 'assistant') {
    return {
      roleLabel,
      sentTimeLabel,
      modelLabel: null,
      costLabel: null,
      tokenRows: null,
      copyableText,
      canSelectText,
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
          { label: i18n.t('agentChat.messageDetails.input'), value: usage.input },
          { label: i18n.t('agentChat.messageDetails.output'), value: usage.output },
          { label: i18n.t('agentChat.messageDetails.reasoning'), value: usage.reasoning },
          { label: i18n.t('agentChat.messageDetails.cacheRead'), value: usage.cacheRead },
          { label: i18n.t('agentChat.messageDetails.cacheWrite'), value: usage.cacheWrite },
          { label: i18n.t('agentChat.messageDetails.total'), value: usage.total },
        ]
      : null,
    copyableText,
    canSelectText,
  };
}

/**
 * A part blocks range selection while it is in flight. A user text part never
 * streams, so only an assistant text part with a `time` that lacks `end` is
 * in flight; reasoning and tool parts reuse the shared streaming check.
 */
function isPartInFlightForSelect(
  part: StoredMessage['parts'][number],
  role: StoredMessage['info']['role']
): boolean {
  if (part.type === 'text') {
    return role === 'assistant' && part.time !== undefined && part.time.end === undefined;
  }
  return isPartStreaming(part);
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
  const date = new Date(created);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return dateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

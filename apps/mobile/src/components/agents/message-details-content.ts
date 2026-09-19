import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { dateTimeFormat } from '@/lib/intl-cache';

import { collectCopyableText, messageTextParts } from './collect-copyable-text';
import { formatCost } from './context-usage-display';
import { selectMessageFailure } from './message-failure-state';
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
  /**
   * What the sheet's Copy action copies: the message's own text plus, on a
   * failed delivery, the untranslated transport text. The select-text view
   * renders `copyableText`, so the raw string stays behind the copy action
   * only.
   */
  copyText: string | null;
  canSelectText: boolean;
};

/**
 * Pure projection of a StoredMessage into the details-sheet fields.
 * Unit-tested for happy / empty visibility rules; the sheet component
 * only renders this shape.
 *
 * When the message's delivery failed, the raw transport text joins the Copy
 * payload (the failure footer never renders it): the sheet's Copy action is
 * where the untranslated original stays reachable, as with a terminal error.
 */
export function getMessageDetailsContent(
  message: StoredMessage,
  modelOptions: SessionModelOption[],
  deliveryState?: MessageDeliveryState
): MessageDetailsContent {
  const roleLabel =
    message.info.role === 'user'
      ? i18n.t('agentChat.messageDetails.roleUser')
      : i18n.t('agentChat.messageDetails.roleAssistant');
  const sentTimeLabel = formatMessageSentTime(message.info.time.created);
  // The select-text view renders every copyable part — the thinking block and
  // the tool output included — so manual selection still sees the whole
  // message. Only the Copy action (below) is scoped to the message's own text.
  const selectable = collectCopyableText(message);
  // Copy message copies the message's own text only. The details sheet shows
  // the thinking block above an assistant reply as its own row; the clipboard
  // must start with the reply, so reasoning and tool parts are not collected.
  const copyable = collectCopyableText({ parts: messageTextParts(message.parts) });
  const failureCopyDetail =
    selectMessageFailure({ deliveryState, info: message.info })?.copyDetail ?? '';
  const copyableText = selectable.length > 0 ? selectable : null;
  const fullCopy = [copyable, failureCopyDetail].filter(text => text.length > 0).join('\n\n');
  const copyText = fullCopy.length > 0 ? fullCopy : null;
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
      copyText,
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
    copyText,
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

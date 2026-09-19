import { type MessageDeliveryState, type MessageInfo } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';

/**
 * Fixed, safe copy for a failed user-message delivery, keyed by the delivery
 * `reason`. Never surfaces raw provider or transport text.
 */
type DeliveryReason = Extract<MessageDeliveryState, { status: 'failed' }>['reason'];

const DELIVERY_DETAIL_KEY_BY_REASON = {
  interrupted: 'agentChat.messageFailure.deliveryInterrupted',
  exhausted: 'agentChat.messageFailure.deliveryExhausted',
  execution: 'agentChat.messageFailure.deliveryExecution',
} as const satisfies Record<DeliveryReason, string>;

/**
 * Assistant error names that can never be retried. Pinned to the exact names
 * in `packages/app-shared/src/opencode.gen.ts`.
 */
export const NON_RETRYABLE_ASSISTANT_ERRORS: readonly string[] = [
  'ProviderAuthError',
  'MessageAbortedError',
  'ContextOverflowError',
];

/**
 * Fixed, safe copy for a known assistant error name. An unknown name has no
 * line of its own: the title already states that the response failed, so the
 * footer adds no detail rather than repeating the title in a sentence
 * (`messageFailure.assistantFailed` is the fixed footer's line, not the
 * message row's). Never surfaces `error.data` or provider message text.
 */
function assistantDetail(errorName: string): string | null {
  switch (errorName) {
    case 'ProviderAuthError': {
      return i18n.t('agentChat.messageFailure.assistantProviderRejected');
    }
    case 'MessageAbortedError': {
      return i18n.t('agentChat.messageFailure.assistantStopped');
    }
    case 'ContextOverflowError': {
      return i18n.t('agentChat.messageFailure.assistantContextOverflow');
    }
    default: {
      return null;
    }
  }
}

export type MessageFailure = {
  kind: 'delivery' | 'assistant';
  title: string;
  /**
   * The explanation line under the title, or `null` when the title alone says
   * it (an assistant failure with no classified reason). The footer then shows
   * one statement plus the action rather than the same sentence twice.
   */
  detail: string | null;
  /**
   * The untranslated transport text for a failed delivery ("Unauthorized:
   * Unauthorized"), for the copy action only — same split as the terminal
   * error's untranslated original. Never rendered; empty for an assistant
   * failure, whose `error.data` is provider text with no diagnostic value.
   */
  copyDetail: string;
  canRetry: boolean;
  canCopy: boolean;
};

export function selectMessageFailure(input: {
  deliveryState?: MessageDeliveryState;
  info: MessageInfo;
}): MessageFailure | null {
  const { deliveryState, info } = input;

  if (info.role === 'user' && deliveryState?.status === 'failed') {
    return {
      kind: 'delivery',
      title: i18n.t('agentChat.messageFailure.deliveryTitle'),
      detail: i18n.t(DELIVERY_DETAIL_KEY_BY_REASON[deliveryState.reason]),
      copyDetail: deliveryState.error,
      canRetry: true,
      canCopy: true,
    };
  }

  if (info.role === 'assistant' && info.error) {
    const errorName = info.error.name;
    return {
      kind: 'assistant',
      title: i18n.t('agentChat.messageFailure.assistantTitle'),
      detail: assistantDetail(errorName),
      copyDetail: '',
      canRetry: !NON_RETRYABLE_ASSISTANT_ERRORS.includes(errorName),
      canCopy: false,
    };
  }

  return null;
}

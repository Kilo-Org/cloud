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
 * Fixed, safe copy for a known assistant error name. Unknown names fall back
 * to the generic line. Never surfaces `error.data` or provider message text.
 */
function assistantDetail(errorName: string): string {
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
      return i18n.t('agentChat.messageFailure.assistantFailed');
    }
  }
}

export type MessageFailure = {
  kind: 'delivery' | 'assistant';
  title: string;
  detail: string;
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
      canRetry: !NON_RETRYABLE_ASSISTANT_ERRORS.includes(errorName),
      canCopy: false,
    };
  }

  return null;
}

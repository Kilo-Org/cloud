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
  // `execution` is the response failure, not a delivery one (the message
  // reached the agent): the row shows the assistant-failure title instead, so
  // this line is never rendered. It stays in the record to keep the reason
  // coverage complete.
  execution: 'agentChat.messageFailure.deliveryExecution',
} as const satisfies Record<DeliveryReason, string>;

/**
 * The one delivery reason that is an agent run failing, not the transport: the
 * message was delivered and the agent could not run it. The row states it in
 * the assistant-failure copy ("Response failed") with no second line — the
 * session's own status line reports the same failure, so a delivery-flavoured
 * title here plus the footer's line read as the failure stated three times
 * (UX-DEFECT session-detail failed turn). Retry and Copy-to-composer keep
 * working: the transport text stays reachable behind the copy action.
 */
const AGENT_EXECUTION_DELIVERY_REASON: DeliveryReason = 'execution';

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
   * it (an assistant failure with no classified reason, or an agent-execution
   * delivery failure whose response-failure title is the whole statement). The
   * footer then shows one statement plus the action rather than the same
   * sentence twice.
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
    if (deliveryState.reason === AGENT_EXECUTION_DELIVERY_REASON) {
      return {
        kind: 'delivery',
        title: i18n.t('agentChat.messageFailure.assistantTitle'),
        detail: null,
        copyDetail: deliveryState.error,
        canRetry: true,
        canCopy: true,
      };
    }
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

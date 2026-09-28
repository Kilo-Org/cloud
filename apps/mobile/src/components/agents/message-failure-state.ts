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
 * The catalog key for a known assistant error name's fixed, safe detail line.
 * An unknown name has no line of its own: the title already states that the
 * response failed, so the footer adds no detail rather than repeating the title
 * in a sentence (`messageFailure.assistantFailed` is the fixed footer's line,
 * not the message row's). Never surfaces `error.data` or provider message text.
 */
function assistantDetailKey(errorName: string): string | null {
  switch (errorName) {
    case 'ProviderAuthError': {
      return 'agentChat.messageFailure.assistantProviderRejected';
    }
    case 'MessageAbortedError': {
      return 'agentChat.messageFailure.assistantStopped';
    }
    case 'ContextOverflowError': {
      return 'agentChat.messageFailure.assistantContextOverflow';
    }
    default: {
      return null;
    }
  }
}

export type MessageFailure = {
  kind: 'delivery' | 'assistant';
  /**
   * The catalog key behind `title`. The duplicate check compares keys, not the
   * resolved copy: `selectMessageFailure` runs inside a memo keyed on the
   * message arrays, so an in-place language switch would otherwise leave a
   * stale-language title that no longer matches the footer copy resolved at
   * render time.
   */
  titleKey: string;
  title: string;
  /**
   * The catalog key behind `detail`, or `null` when the title alone says it (an
   * assistant failure with no classified reason, or an agent-execution delivery
   * failure whose response-failure title is the whole statement). The footer
   * then shows one statement plus the action rather than the same sentence
   * twice.
   */
  detailKey: string | null;
  /**
   * `detailKey` resolved at selection time, for rendering. `null` exactly when
   * `detailKey` is `null`.
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
        titleKey: 'agentChat.messageFailure.assistantTitle',
        title: i18n.t('agentChat.messageFailure.assistantTitle'),
        detailKey: null,
        detail: null,
        copyDetail: deliveryState.error,
        canRetry: true,
        canCopy: true,
      };
    }
    const detailKey = DELIVERY_DETAIL_KEY_BY_REASON[deliveryState.reason];
    return {
      kind: 'delivery',
      titleKey: 'agentChat.messageFailure.deliveryTitle',
      title: i18n.t('agentChat.messageFailure.deliveryTitle'),
      detailKey,
      detail: i18n.t(detailKey),
      copyDetail: deliveryState.error,
      canRetry: true,
      canCopy: true,
    };
  }

  if (info.role === 'assistant' && info.error) {
    const errorName = info.error.name;
    const detailKey = assistantDetailKey(errorName);
    return {
      kind: 'assistant',
      titleKey: 'agentChat.messageFailure.assistantTitle',
      title: i18n.t('agentChat.messageFailure.assistantTitle'),
      detailKey,
      detail: detailKey === null ? null : i18n.t(detailKey),
      copyDetail: '',
      canRetry: !NON_RETRYABLE_ASSISTANT_ERRORS.includes(errorName),
      canCopy: false,
    };
  }

  return null;
}

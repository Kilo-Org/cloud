import { type MessageDeliveryState, type MessageInfo } from '@kilocode/cloud-agent-sdk';

/**
 * Fixed, safe copy for a failed user-message delivery, keyed by the delivery
 * `reason`. Never surfaces raw provider or transport text.
 */
type DeliveryReason = Extract<MessageDeliveryState, { status: 'failed' }>['reason'];

const DELIVERY_DETAIL_BY_REASON = {
  interrupted: 'You stopped this message.',
  exhausted: 'We could not deliver this message after several attempts.',
  execution: 'The agent could not run this message.',
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
      return 'The provider rejected the request.';
    }
    case 'MessageAbortedError': {
      return 'The response was stopped.';
    }
    case 'ContextOverflowError': {
      return 'The conversation is too long for the model.';
    }
    default: {
      return 'The response failed.';
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
      title: 'Failed to deliver',
      detail: DELIVERY_DETAIL_BY_REASON[deliveryState.reason],
      canRetry: true,
      canCopy: true,
    };
  }

  if (info.role === 'assistant' && info.error) {
    const errorName = info.error.name;
    return {
      kind: 'assistant',
      title: 'Response failed',
      detail: assistantDetail(errorName),
      canRetry: !NON_RETRYABLE_ASSISTANT_ERRORS.includes(errorName),
      canCopy: false,
    };
  }

  return null;
}

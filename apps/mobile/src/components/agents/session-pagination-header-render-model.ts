import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import {
  selectSessionMessageListHeaderState,
  type SessionMessageListHeaderStateInputs,
} from '@/components/agents/session-message-list-state';

function omittedMessage(count: number): string {
  return i18n.t('agentChat.olderMessages.omitted', {
    count,
    displayCount: formatNumber(count, i18n.language),
  });
}

export type SessionPaginationHeaderRenderModel =
  | { kind: 'hidden' }
  | {
      kind: 'retryable';
      testID: string;
      text: string;
      retry: { label: string; accessibilityHint: string };
    }
  | { kind: 'invalid_data'; testID: string; text: string }
  | { kind: 'too_large'; testID: string; text: string }
  | { kind: 'omitted'; testID: string; text: string };

function omittedRenderModel(count: number): SessionPaginationHeaderRenderModel {
  return {
    kind: 'omitted',
    testID: 'session-pagination-header-omitted',
    text: omittedMessage(count),
  };
}

export function selectSessionPaginationHeaderRenderModel(
  inputs: SessionMessageListHeaderStateInputs
): SessionPaginationHeaderRenderModel {
  const state = selectSessionMessageListHeaderState(inputs);

  if (state.kind === 'hidden') {
    return { kind: 'hidden' };
  }

  // Suppress the transient loading placeholder so FlashList mVCP is not
  // disturbed by a header height collapse when the older page arrives.
  // When an omitted banner is already visible (count > 0), keep it stable
  // through the load instead of hiding it — a hide/show flap would reintroduce
  // the same jump. The state layer still prioritizes `loading` over `omitted`;
  // this mapping is render-model only.
  if (state.kind === 'loading') {
    if (inputs.olderMessagesOmittedItemCount > 0) {
      return omittedRenderModel(inputs.olderMessagesOmittedItemCount);
    }
    return { kind: 'hidden' };
  }

  if (state.kind === 'retryable') {
    return {
      kind: 'retryable',
      testID: 'session-pagination-header-retryable',
      text: i18n.t('agentChat.olderMessages.couldNotLoad'),
      retry: {
        label: i18n.t('common.retry'),
        accessibilityHint: i18n.t('agentChat.olderMessages.retryHint'),
      },
    };
  }

  if (state.kind === 'invalid_data') {
    return {
      kind: 'invalid_data',
      testID: 'session-pagination-header-invalid-data',
      text: i18n.t('agentChat.olderMessages.unavailable'),
    };
  }

  if (state.kind === 'too_large') {
    return {
      kind: 'too_large',
      testID: 'session-pagination-header-too-large',
      text: i18n.t('agentChat.olderMessages.tooLarge'),
    };
  }

  return omittedRenderModel(state.count);
}

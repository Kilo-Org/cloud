import {
  selectSessionMessageListHeaderState,
  type SessionMessageListHeaderStateInputs,
} from '@/components/agents/session-message-list-state';

const RETRY_LABEL = 'Retry';
const RETRY_HINT = 'Reattempts the older-messages load for this session.';

function omittedMessage(count: number): string {
  if (count === 1) {
    return 'Some earlier items from this session could not be displayed.';
  }
  return `${count} earlier items from this session could not be displayed.`;
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
      text: "Couldn't load earlier messages.",
      retry: { label: RETRY_LABEL, accessibilityHint: RETRY_HINT },
    };
  }

  if (state.kind === 'invalid_data') {
    return {
      kind: 'invalid_data',
      testID: 'session-pagination-header-invalid-data',
      text: "Earlier messages aren't available.",
    };
  }

  if (state.kind === 'too_large') {
    return {
      kind: 'too_large',
      testID: 'session-pagination-header-too-large',
      text: 'Earlier messages are too large to load.',
    };
  }

  return omittedRenderModel(state.count);
}

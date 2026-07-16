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
  | { kind: 'loading'; testID: string; accessibilityRole: 'progressbar'; text: null }
  | {
      kind: 'retryable';
      testID: string;
      text: string;
      retry: { label: string; accessibilityHint: string };
    }
  | { kind: 'invalid_data'; testID: string; text: string }
  | { kind: 'too_large'; testID: string; text: string }
  | { kind: 'omitted'; testID: string; text: string };

export function selectSessionPaginationHeaderRenderModel(
  inputs: SessionMessageListHeaderStateInputs
): SessionPaginationHeaderRenderModel {
  const state = selectSessionMessageListHeaderState(inputs);

  if (state.kind === 'hidden') {
    return { kind: 'hidden' };
  }

  if (state.kind === 'loading') {
    return {
      kind: 'loading',
      testID: 'session-pagination-header-loading',
      accessibilityRole: 'progressbar',
      text: null,
    };
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

  return {
    kind: 'omitted',
    testID: 'session-pagination-header-omitted',
    text: omittedMessage(state.count),
  };
}

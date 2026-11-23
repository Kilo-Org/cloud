import { describe, expect, it } from '@jest/globals';
import type {
  ChildSessionHydrationState,
  SessionSnapshotFailureKind,
} from '@kilocode/cloud-agent-sdk';
import { describeChildDrawerHistoryFailure } from './child-session-drawer-history';

function errorState(
  kind: SessionSnapshotFailureKind | null,
  message = 'Child session not found'
): Extract<ChildSessionHydrationState, { status: 'error' }> {
  return { status: 'error', kind, message };
}

describe('describeChildDrawerHistoryFailure', () => {
  it('offers a retry and the stored message for a retryable failure', () => {
    expect(
      describeChildDrawerHistoryFailure(
        errorState('retryable_failure', 'Session history temporarily unavailable')
      )
    ).toEqual({ message: 'Session history temporarily unavailable', canRetry: true });
  });

  it('offers a retry and the stored message when the failure has no typed kind', () => {
    expect(describeChildDrawerHistoryFailure(errorState(null))).toEqual({
      message: 'Child session not found',
      canRetry: true,
    });
  });

  it('shows terminal copy without a retry for an oversized history', () => {
    expect(describeChildDrawerHistoryFailure(errorState('too_large'))).toEqual({
      message: "This sub-agent's history is too large to load.",
      canRetry: false,
    });
  });

  it('shows terminal copy without a retry for unreadable history data', () => {
    expect(describeChildDrawerHistoryFailure(errorState('invalid_data'))).toEqual({
      message: "This sub-agent's history isn't available.",
      canRetry: false,
    });
  });
});

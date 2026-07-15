import { type OlderMessagesError } from 'cloud-agent-sdk';
import { describe, expect, it } from 'vitest';
import {
  selectSessionMessageListHeaderState,
  shouldTriggerOlderMessagesLoad,
} from '@/components/agents/session-message-list-state';

function error(kind: OlderMessagesError['kind']): OlderMessagesError {
  return { kind };
}

describe('selectSessionMessageListHeaderState', () => {
  it('returns hidden when nothing is loading, no error, and no omitted items', () => {
    expect(
      selectSessionMessageListHeaderState({
        isLoadingOlderMessages: false,
        olderMessagesError: null,
        olderMessagesOmittedItemCount: 0,
      })
    ).toEqual({ kind: 'hidden' });
  });

  it('returns loading while a page is in flight and there is no error yet', () => {
    expect(
      selectSessionMessageListHeaderState({
        isLoadingOlderMessages: true,
        olderMessagesError: null,
        olderMessagesOmittedItemCount: 0,
      })
    ).toEqual({ kind: 'loading' });
  });

  it('returns retryable when the most recent older load failed retryably', () => {
    expect(
      selectSessionMessageListHeaderState({
        isLoadingOlderMessages: false,
        olderMessagesError: error('retryable'),
        olderMessagesOmittedItemCount: 0,
      })
    ).toEqual({ kind: 'retryable' });
  });

  it('prefers the retryable error over an in-flight retry so the CTA appears on the first frame after failure', () => {
    expect(
      selectSessionMessageListHeaderState({
        isLoadingOlderMessages: true,
        olderMessagesError: error('retryable'),
        olderMessagesOmittedItemCount: 0,
      })
    ).toEqual({ kind: 'retryable' });
  });

  it('returns invalid_data for a non-retryable invalid_data failure and hides omitted noise', () => {
    expect(
      selectSessionMessageListHeaderState({
        isLoadingOlderMessages: false,
        olderMessagesError: error('invalid_data'),
        olderMessagesOmittedItemCount: 7,
      })
    ).toEqual({ kind: 'invalid_data' });
  });

  it('returns too_large for a non-retryable too_large failure and hides omitted noise', () => {
    expect(
      selectSessionMessageListHeaderState({
        isLoadingOlderMessages: false,
        olderMessagesError: error('too_large'),
        olderMessagesOmittedItemCount: 2,
      })
    ).toEqual({ kind: 'too_large' });
  });

  it('returns omitted with the running count when prior pages skipped items and no error is set', () => {
    expect(
      selectSessionMessageListHeaderState({
        isLoadingOlderMessages: false,
        olderMessagesError: null,
        olderMessagesOmittedItemCount: 5,
      })
    ).toEqual({ kind: 'omitted', count: 5 });
  });

  it('hides omitted noise while a page is loading and the count is non-zero', () => {
    // The skeleton replaces the calm informational message; once the page
    // resolves, the omitted message returns only if no error overrides it.
    expect(
      selectSessionMessageListHeaderState({
        isLoadingOlderMessages: true,
        olderMessagesError: null,
        olderMessagesOmittedItemCount: 5,
      })
    ).toEqual({ kind: 'loading' });
  });
});

describe('shouldTriggerOlderMessagesLoad', () => {
  it('returns false when there are no older messages', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: false,
        isLoadingOlderMessages: false,
        isInFlight: false,
        olderMessagesError: null,
      })
    ).toBe(false);
  });

  it('returns false when a page is already loading', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: true,
        isLoadingOlderMessages: true,
        isInFlight: false,
        olderMessagesError: null,
      })
    ).toBe(false);
  });

  it('returns false while the local in-flight latch is still set', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: true,
        isLoadingOlderMessages: false,
        isInFlight: true,
        olderMessagesError: null,
      })
    ).toBe(false);
  });

  it('returns false for a non-retryable invalid_data terminal failure', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: true,
        isLoadingOlderMessages: false,
        isInFlight: false,
        olderMessagesError: error('invalid_data'),
      })
    ).toBe(false);
  });

  it('returns false for a non-retryable too_large terminal failure', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: true,
        isLoadingOlderMessages: false,
        isInFlight: false,
        olderMessagesError: error('too_large'),
      })
    ).toBe(false);
  });

  it('returns true for a retryable failure so the gesture can re-trigger', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: true,
        isLoadingOlderMessages: false,
        isInFlight: false,
        olderMessagesError: error('retryable'),
      })
    ).toBe(true);
  });

  it('returns true in the happy path with no error and a cursor', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: true,
        isLoadingOlderMessages: false,
        isInFlight: false,
        olderMessagesError: null,
      })
    ).toBe(true);
  });

  it('gives the loading/in-flight guards priority over the retryable path', () => {
    // Loading and in-flight are checked before the error kind, so even a
    // retryable error cannot re-trigger while work is outstanding.
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: true,
        isLoadingOlderMessages: true,
        isInFlight: true,
        olderMessagesError: error('retryable'),
      })
    ).toBe(false);
  });
});

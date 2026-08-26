import { describe, expect, it } from '@jest/globals';
import { type OlderMessagesError } from '@kilocode/cloud-agent-sdk';
import {
  restoreScrollAfterPrepend,
  selectOlderMessagesHeaderState,
  shouldAnnounceOlderMessagesArrival,
  shouldTriggerOlderMessagesLoad,
} from './older-messages-scroll';

function error(kind: OlderMessagesError['kind']): OlderMessagesError {
  return { kind };
}

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

describe('restoreScrollAfterPrepend', () => {
  it('adds the height delta to scrollTop', () => {
    const el = { scrollTop: 12, scrollHeight: 800 };
    restoreScrollAfterPrepend(el, 500);
    expect(el.scrollTop).toBe(312);
  });

  it('leaves scrollTop unchanged when height did not grow', () => {
    const el = { scrollTop: 40, scrollHeight: 400 };
    restoreScrollAfterPrepend(el, 400);
    expect(el.scrollTop).toBe(40);
  });
});

describe('selectOlderMessagesHeaderState', () => {
  it('hides the banner while loading with no omitted count', () => {
    expect(
      selectOlderMessagesHeaderState({
        isLoadingOlderMessages: true,
        olderMessagesError: null,
        olderMessagesOmittedItemCount: 0,
      })
    ).toEqual({ kind: 'hidden' });
  });

  it('keeps the omitted banner through a subsequent load', () => {
    expect(
      selectOlderMessagesHeaderState({
        isLoadingOlderMessages: true,
        olderMessagesError: null,
        olderMessagesOmittedItemCount: 5,
      })
    ).toEqual({ kind: 'omitted', count: 5 });
  });

  it('prefers a retryable error over loading', () => {
    expect(
      selectOlderMessagesHeaderState({
        isLoadingOlderMessages: true,
        olderMessagesError: error('retryable'),
        olderMessagesOmittedItemCount: 0,
      })
    ).toEqual({ kind: 'retryable' });
  });
});

describe('shouldAnnounceOlderMessagesArrival', () => {
  it('announces only when items prepend after the list has painted', () => {
    expect(
      shouldAnnounceOlderMessagesArrival({
        wasInitialized: true,
        previousCount: 10,
        nextCount: 20,
        previousNewestKey: 'msg_new',
        nextNewestKey: 'msg_new',
      })
    ).toBe(true);
  });

  it('skips the initial paint', () => {
    expect(
      shouldAnnounceOlderMessagesArrival({
        wasInitialized: false,
        previousCount: 0,
        nextCount: 10,
        previousNewestKey: null,
        nextNewestKey: 'msg_new',
      })
    ).toBe(false);
  });
});

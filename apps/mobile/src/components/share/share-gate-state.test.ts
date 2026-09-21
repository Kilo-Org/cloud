import { describe, expect, it } from 'vitest';

import { type SharePayload } from '@/lib/share-payload';

import {
  isShareCommitEnabled,
  selectShareGateState,
  type ShareGateStateInput,
} from './share-gate-state';
import { type SharePayloadValidation } from './share-payload-validation';

const payload: SharePayload = { text: 'hello', files: [], failedFiles: [] };

const okValidation: SharePayloadValidation = {
  kind: 'ok',
  accepted: [],
  rejectedNotes: [],
  truncated: false,
  usable: true,
};

const allRejected: SharePayloadValidation = {
  kind: 'all-rejected',
  reason: 'denied',
  message: "Executable files can't be attached",
};

function base(overrides: Partial<ShareGateStateInput> = {}): ShareGateStateInput {
  return {
    shareId: 'share-1',
    payload,
    validation: okValidation,
    storedIsError: false,
    storedIsSuccess: true,
    storedIsPaused: false,
    activeIsError: false,
    activeIsPaused: false,
    liveRowCount: 3,
    storedSessionCount: 3,
    isLoading: false,
    ...overrides,
  };
}

describe('isShareCommitEnabled', () => {
  it('false while validation is pending', () => {
    expect(isShareCommitEnabled({ orgLoaded: true, validation: null })).toBe(false);
  });

  it('false while org is not loaded', () => {
    expect(isShareCommitEnabled({ orgLoaded: false, validation: okValidation })).toBe(false);
  });

  it('false when settled all-rejected', () => {
    expect(isShareCommitEnabled({ orgLoaded: true, validation: allRejected })).toBe(false);
  });

  it('true when ok and org loaded', () => {
    expect(isShareCommitEnabled({ orgLoaded: true, validation: okValidation })).toBe(true);
  });
});

describe('selectShareGateState', () => {
  it('stale-share when shareId is missing', () => {
    const state = selectShareGateState(base({ shareId: undefined }));
    expect(state.kind).toBe('stale-share');
    if (state.kind === 'stale-share') {
      expect(state.message).toBe('This share is no longer available.');
      expect(state.showNewSession).toBe(false);
      expect(state.showRetry).toBe(false);
      expect(state.showList).toBe(false);
    }
  });

  it('stale-share when shareId is empty', () => {
    expect(selectShareGateState(base({ shareId: '  ' })).kind).toBe('stale-share');
  });

  it('stale-share when payload is null (consumed/unknown)', () => {
    const state = selectShareGateState(base({ payload: null }));
    expect(state.kind).toBe('stale-share');
    expect(state.showNewSession).toBe(false);
    expect(state.showRetry).toBe(false);
  });

  it('stale-share is detected before validation runs', () => {
    const state = selectShareGateState(base({ payload: null, validation: null, isLoading: true }));
    expect(state.kind).toBe('stale-share');
  });

  it('non-retryable-classification for all-rejected with no CTA', () => {
    const state = selectShareGateState(base({ validation: allRejected }));
    expect(state.kind).toBe('non-retryable-classification');
    if (state.kind === 'non-retryable-classification') {
      expect(state.message).toBe("Executable files can't be attached");
      expect(state.showNewSession).toBe(false);
      expect(state.showRetry).toBe(false);
      expect(state.showList).toBe(false);
    }
  });

  it('does not conflate stale-share and non-retryable-classification', () => {
    const stale = selectShareGateState(base({ payload: null }));
    const rejected = selectShareGateState(base({ validation: allRejected }));
    expect(stale.kind).not.toBe(rejected.kind);
    expect(stale.kind).toBe('stale-share');
    expect(rejected.kind).toBe('non-retryable-classification');
  });

  it('loading while validation is pending', () => {
    const state = selectShareGateState(base({ validation: null }));
    expect(state.kind).toBe('loading');
    if (state.kind === 'loading') {
      expect(state.showNewSession).toBe(true);
      expect(state.showRetry).toBe(false);
      expect(state.showList).toBe(true);
      expect(state.listMode).toBe('skeleton');
    }
  });

  it('loading while destination queries are in flight', () => {
    const state = selectShareGateState(
      base({ isLoading: true, storedIsSuccess: false, liveRowCount: 0 })
    );
    expect(state.kind).toBe('loading');
    expect(state.showNewSession).toBe(true);
  });

  it('retryable when storedIsError with zero live rows', () => {
    const state = selectShareGateState(
      base({
        storedIsError: true,
        storedIsSuccess: false,
        liveRowCount: 0,
        isLoading: false,
      })
    );
    expect(state.kind).toBe('retryable');
    if (state.kind === 'retryable') {
      expect(state.message).toBe("Couldn't load your sessions.");
      expect(state.showRetry).toBe(true);
      expect(state.showNewSession).toBe(true);
      expect(state.showList).toBe(false);
    }
  });

  it('activeIsError alone is NOT retryable while live rows are offered', () => {
    const state = selectShareGateState(
      base({
        activeIsError: true,
        storedIsError: false,
        storedIsSuccess: true,
        liveRowCount: 2,
      })
    );
    expect(state.kind).toBe('happy');
    expect(state.showRetry).toBe(false);
  });

  it('retryable when the live lookup failed and stored sessions exist', () => {
    const state = selectShareGateState(
      base({
        activeIsError: true,
        storedIsError: false,
        storedIsSuccess: true,
        liveRowCount: 0,
        storedSessionCount: 2,
      })
    );
    expect(state.kind).toBe('retryable');
    if (state.kind === 'retryable') {
      expect(state.message).toBe("Couldn't load your sessions.");
      expect(state.showRetry).toBe(true);
      expect(state.showNewSession).toBe(true);
      expect(state.showList).toBe(false);
    }
  });

  it('treats the live lookup failure as retryable whenever no live row is offered', () => {
    const state = selectShareGateState(
      base({
        activeIsError: true,
        storedIsError: false,
        storedIsSuccess: true,
        liveRowCount: 0,
        storedSessionCount: 0,
      })
    );
    expect(state.kind).toBe('retryable');
    expect(state.showRetry).toBe(true);
    expect(state.showNewSession).toBe(true);
  });

  it('retryable when the live lookup is paused with zero live rows', () => {
    const state = selectShareGateState(
      base({
        activeIsPaused: true,
        storedIsError: false,
        storedIsSuccess: true,
        liveRowCount: 0,
        storedSessionCount: 2,
      })
    );
    expect(state.kind).toBe('retryable');
    if (state.kind === 'retryable') {
      expect(state.message).toBe("Couldn't load your sessions.");
      expect(state.showRetry).toBe(true);
      expect(state.showNewSession).toBe(true);
      expect(state.showList).toBe(false);
    }
  });

  it('happy when the live lookup is paused but cached live rows are offered', () => {
    const state = selectShareGateState(
      base({
        activeIsPaused: true,
        storedIsError: false,
        storedIsSuccess: true,
        liveRowCount: 2,
      })
    );
    expect(state.kind).toBe('happy');
    expect(state.showRetry).toBe(false);
  });

  it('retryable when the stored page is paused with no cache (fresh offline open)', () => {
    // Offline fresh open: the stored infinite query is paused with no cached
    // page, so it is neither loading nor errored and offers no rows. It must
    // not settle on the skeleton; the user needs a Retry.
    const state = selectShareGateState(
      base({
        storedIsError: false,
        storedIsSuccess: false,
        storedIsPaused: true,
        activeIsError: false,
        activeIsPaused: true,
        liveRowCount: 0,
        storedSessionCount: 0,
        isLoading: false,
      })
    );
    expect(state.kind).toBe('retryable');
    if (state.kind === 'retryable') {
      expect(state.message).toBe("Couldn't load your sessions.");
      expect(state.showRetry).toBe(true);
      expect(state.showNewSession).toBe(true);
      expect(state.showList).toBe(false);
    }
  });

  it('loading while the stored page is unresolved but not paused', () => {
    const state = selectShareGateState(
      base({
        storedIsError: false,
        storedIsSuccess: false,
        storedIsPaused: false,
        liveRowCount: 0,
        storedSessionCount: 0,
        isLoading: false,
      })
    );
    expect(state.kind).toBe('loading');
  });

  it('empty when settled with zero live rows and no stored sessions', () => {
    const state = selectShareGateState(
      base({
        liveRowCount: 0,
        storedSessionCount: 0,
        storedIsSuccess: true,
        storedIsError: false,
      })
    );
    expect(state.kind).toBe('empty');
    if (state.kind === 'empty') {
      expect(state.message).toBe('No sessions yet — start a new one to send this.');
      expect(state.showNewSession).toBe(true);
      expect(state.showRetry).toBe(false);
      expect(state.showList).toBe(false);
    }
  });

  it('empty with live-aware copy when stored sessions exist but none are live', () => {
    const state = selectShareGateState(
      base({
        liveRowCount: 0,
        storedSessionCount: 4,
        storedIsSuccess: true,
        storedIsError: false,
      })
    );
    expect(state.kind).toBe('empty');
    if (state.kind === 'empty') {
      // Reuses the app's live-empty copy (`home.noLiveSessions`), never
      // `share.emptyMessage`, so offline sessions are not called "no sessions".
      expect(state.message).toBe('Nothing running right now');
      expect(state.showNewSession).toBe(true);
      expect(state.showRetry).toBe(false);
      expect(state.showList).toBe(false);
    }
  });

  it('happy when payload valid and queries settled with rows', () => {
    const state = selectShareGateState(base({ liveRowCount: 5 }));
    expect(state.kind).toBe('happy');
    if (state.kind === 'happy') {
      expect(state.showNewSession).toBe(true);
      expect(state.showRetry).toBe(false);
      expect(state.showList).toBe(true);
      expect(state.listMode).toBe('rows');
    }
  });

  it('classification beats loading (validation settled to all-rejected)', () => {
    const state = selectShareGateState(
      base({ validation: allRejected, isLoading: true, storedIsSuccess: false })
    );
    expect(state.kind).toBe('non-retryable-classification');
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { type PendingLinkOffer } from '@/lib/auth/native-auth-contract';
import {
  readPendingLinkOffer,
  recordPendingLinkOutcome,
  setPendingLinkOffer,
  takePendingLinkOutcome,
} from '@/lib/auth/pending-link-state';

const offer: PendingLinkOffer = {
  token: 'link-token',
  provider: 'github',
  email: 'person@example.com',
  methods: ['google'],
  emailCode: true,
  expiresAt: Date.now() + 15 * 60 * 1000,
};

afterEach(() => {
  setPendingLinkOffer(null);
});

describe('pending link state', () => {
  it('reads the offer back after the screen that set it unmounted', () => {
    setPendingLinkOffer(offer);
    expect(readPendingLinkOffer()).toEqual(offer);
  });

  it('reads a recorded outcome once', () => {
    setPendingLinkOffer(offer);
    recordPendingLinkOutcome({ status: 'failed', reason: 'WRONG_ACCOUNT' });

    expect(takePendingLinkOutcome()).toEqual({ status: 'failed', reason: 'WRONG_ACCOUNT' });
    expect(takePendingLinkOutcome()).toBeUndefined();
  });

  it('keeps a completed sign-in that added nothing as its own outcome', () => {
    setPendingLinkOffer(offer);
    recordPendingLinkOutcome({ status: 'not-added' });
    expect(takePendingLinkOutcome()).toEqual({ status: 'not-added' });
  });

  it('drops the outcome of a link a new one replaces', () => {
    setPendingLinkOffer(offer);
    recordPendingLinkOutcome({ status: 'linked', provider: 'github' });
    setPendingLinkOffer({ ...offer, token: 'other-token' });

    expect(takePendingLinkOutcome()).toBeUndefined();
    expect(readPendingLinkOffer()?.token).toBe('other-token');
  });

  it('starts empty', () => {
    expect(readPendingLinkOffer()).toBeNull();
    expect(takePendingLinkOutcome()).toBeUndefined();
  });
});

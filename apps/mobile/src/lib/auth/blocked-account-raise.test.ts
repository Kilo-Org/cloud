import { beforeEach, describe, expect, it } from 'vitest';

import {
  getBlockedAccountExplanation,
  isBlockedAccountActive,
  setBlockedAccountExplanation,
  subscribeBlockedAccount,
} from '@/lib/auth/blocked-account-state';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { setSignOutTeardownActive } from '@/lib/auth/auth-transition-state';
import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { tagDispatchSession, tagDispatchSessionAt } from '@/lib/auth/dispatch-epoch';
import {
  raiseBlockedAccountExplanationFromRefresh,
  raiseBlockedAccountFromRefusal,
} from '@/lib/auth/blocked-account-raise';

const BLOCKED_REFUSAL = { data: { code: 'FORBIDDEN', accountBlocked: true } };
const OTHER_FORBIDDEN = { data: { code: 'FORBIDDEN' } };

describe('raiseBlockedAccountFromRefusal', () => {
  beforeEach(() => {
    setBlockedAccountExplanation(null);
    setSignOutActive(false);
    setSignOutTeardownActive(false);
  });

  it('raises the explanation for a blocked refusal', () => {
    tagDispatchSession(BLOCKED_REFUSAL);

    raiseBlockedAccountFromRefusal(BLOCKED_REFUSAL);

    expect(isBlockedAccountActive()).toBe(true);
    setBlockedAccountExplanation(null);
  });

  it('publishes the reason the refusal carried', () => {
    const domainRefusal = {
      data: {
        code: 'FORBIDDEN',
        accountBlocked: true,
        accountBlockedReason: 'email_domain_blocked',
      },
    };
    tagDispatchSession(domainRefusal);

    raiseBlockedAccountFromRefusal(domainRefusal);

    expect(getBlockedAccountExplanation()).toBe('email_domain_blocked');
    setBlockedAccountExplanation(null);
  });

  it('publishes the account refusal whose envelope names it', () => {
    const accountRefusal = {
      data: { code: 'FORBIDDEN', accountBlocked: true, accountBlockedReason: 'account_blocked' },
    };
    tagDispatchSession(accountRefusal);

    raiseBlockedAccountFromRefusal(accountRefusal);

    expect(getBlockedAccountExplanation()).toBe('account_blocked');
    setBlockedAccountExplanation(null);
  });

  it('falls back to the account explanation for a refusal that names no reason', () => {
    tagDispatchSession(BLOCKED_REFUSAL);

    raiseBlockedAccountFromRefusal(BLOCKED_REFUSAL);

    expect(getBlockedAccountExplanation()).toBe('account_blocked');
    setBlockedAccountExplanation(null);
  });

  it('leaves other refusals alone', () => {
    tagDispatchSession(OTHER_FORBIDDEN);

    raiseBlockedAccountFromRefusal(OTHER_FORBIDDEN);
    raiseBlockedAccountFromRefusal(new Error('network'));
    raiseBlockedAccountFromRefusal(undefined);

    expect(isBlockedAccountActive()).toBe(false);
  });

  it('does not replace a more specific raised reason', () => {
    let calls = 0;
    const listener = (): void => {
      calls += 1;
    };
    setBlockedAccountExplanation('email_domain_blocked');
    tagDispatchSession(BLOCKED_REFUSAL);
    const unsubscribe = subscribeBlockedAccount(listener);

    raiseBlockedAccountFromRefusal(BLOCKED_REFUSAL);

    expect(getBlockedAccountExplanation()).toBe('email_domain_blocked');
    expect(calls).toBe(0);
    unsubscribe();
    setBlockedAccountExplanation(null);
  });

  it('does not raise while the sign-out fence is closed', () => {
    setSignOutActive(true);
    tagDispatchSession(BLOCKED_REFUSAL);

    raiseBlockedAccountFromRefusal(BLOCKED_REFUSAL);

    expect(isBlockedAccountActive()).toBe(false);
    setSignOutActive(false);
  });

  it('does not raise while the teardown guard is closed', () => {
    // The guard covers the sign-in window (transition start to credential
    // publication) as well as sign-out: a refusal from the previous session
    // settling in that window must not raise over the account just signed in.
    setSignOutTeardownActive(true);
    tagDispatchSession(BLOCKED_REFUSAL);

    raiseBlockedAccountFromRefusal(BLOCKED_REFUSAL);

    expect(isBlockedAccountActive()).toBe(false);
    setSignOutTeardownActive(false);
  });

  it('does not raise for a refusal no dispatch session tagged', () => {
    raiseBlockedAccountFromRefusal({ data: { code: 'FORBIDDEN', accountBlocked: true } });

    expect(isBlockedAccountActive()).toBe(false);
  });

  it('does not raise for a refusal dispatched by an earlier session, even with both boolean fences open', () => {
    const refusal = { data: { code: 'FORBIDDEN', accountBlocked: true } };
    tagDispatchSessionAt(refusal, currentAuthEpoch());
    // A sign-in bumps the epoch and clears both booleans, so this is exactly the
    // state in which a stale refusal used to raise.
    bumpAuthEpoch();
    setSignOutActive(false);
    setSignOutTeardownActive(false);

    raiseBlockedAccountFromRefusal(refusal);

    expect(isBlockedAccountActive()).toBe(false);
  });
});

describe('raiseBlockedAccountExplanationFromRefresh', () => {
  beforeEach(() => {
    setBlockedAccountExplanation(null);
  });

  it('raises the account explanation from the cleared state', () => {
    raiseBlockedAccountExplanationFromRefresh();

    expect(getBlockedAccountExplanation()).toBe('account_blocked');
    setBlockedAccountExplanation(null);
  });

  // The refresh route's frozen body names only a block, so it must not
  // downgrade the domain reason an answered procedure published: the surface
  // would then offer a Retry no domain refusal can ever pass.
  it('leaves a more specific raised reason untouched, without notifying', () => {
    let calls = 0;
    const listener = (): void => {
      calls += 1;
    };
    setBlockedAccountExplanation('email_domain_blocked');
    const unsubscribe = subscribeBlockedAccount(listener);

    raiseBlockedAccountExplanationFromRefresh();

    expect(getBlockedAccountExplanation()).toBe('email_domain_blocked');
    expect(calls).toBe(0);
    unsubscribe();
    setBlockedAccountExplanation(null);
  });
});

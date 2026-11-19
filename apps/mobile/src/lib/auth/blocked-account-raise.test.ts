import { beforeEach, describe, expect, it } from 'vitest';

import {
  isBlockedAccountActive,
  setBlockedAccountActive,
  subscribeBlockedAccount,
} from '@/lib/auth/blocked-account-state';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { setSignOutTeardownActive } from '@/lib/auth/auth-transition-state';
import { raiseBlockedAccountFromRefusal } from '@/lib/auth/blocked-account-raise';

const BLOCKED_REFUSAL = { data: { code: 'FORBIDDEN', accountBlocked: true } };
const OTHER_FORBIDDEN = { data: { code: 'FORBIDDEN' } };

describe('raiseBlockedAccountFromRefusal', () => {
  beforeEach(() => {
    setBlockedAccountActive(false);
    setSignOutActive(false);
    setSignOutTeardownActive(false);
  });

  it('raises the explanation for a blocked refusal', () => {
    raiseBlockedAccountFromRefusal(BLOCKED_REFUSAL);

    expect(isBlockedAccountActive()).toBe(true);
    setBlockedAccountActive(false);
  });

  it('leaves other refusals alone', () => {
    raiseBlockedAccountFromRefusal(OTHER_FORBIDDEN);
    raiseBlockedAccountFromRefusal(new Error('network'));
    raiseBlockedAccountFromRefusal(undefined);

    expect(isBlockedAccountActive()).toBe(false);
  });

  it('does not publish over an already-raised state', () => {
    let calls = 0;
    const listener = (): void => {
      calls += 1;
    };
    setBlockedAccountActive(true);
    const unsubscribe = subscribeBlockedAccount(listener);

    raiseBlockedAccountFromRefusal(BLOCKED_REFUSAL);

    expect(calls).toBe(0);
    unsubscribe();
    setBlockedAccountActive(false);
  });

  it('does not raise while the sign-out fence is closed', () => {
    setSignOutActive(true);

    raiseBlockedAccountFromRefusal(BLOCKED_REFUSAL);

    expect(isBlockedAccountActive()).toBe(false);
    setSignOutActive(false);
  });

  it('does not raise while the teardown guard is closed', () => {
    // The guard covers the sign-in window (transition start to credential
    // publication) as well as sign-out: a refusal from the previous session
    // settling in that window must not raise over the account just signed in.
    setSignOutTeardownActive(true);

    raiseBlockedAccountFromRefusal(BLOCKED_REFUSAL);

    expect(isBlockedAccountActive()).toBe(false);
    setSignOutTeardownActive(false);
  });
});

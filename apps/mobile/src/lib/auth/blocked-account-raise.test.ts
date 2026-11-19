import { beforeEach, describe, expect, it } from 'vitest';

import {
  isBlockedAccountActive,
  setBlockedAccountActive,
  subscribeBlockedAccount,
} from '@/lib/auth/blocked-account-state';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { raiseBlockedAccountFromRefusal } from '@/lib/auth/blocked-account-raise';

const BLOCKED_REFUSAL = { data: { code: 'FORBIDDEN', accountBlocked: true } };
const OTHER_FORBIDDEN = { data: { code: 'FORBIDDEN' } };

describe('raiseBlockedAccountFromRefusal', () => {
  beforeEach(() => {
    setBlockedAccountActive(false);
    setSignOutActive(false);
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

  it('does not raise during a sign-out teardown', () => {
    setSignOutActive(true);

    raiseBlockedAccountFromRefusal(BLOCKED_REFUSAL);

    expect(isBlockedAccountActive()).toBe(false);
    setSignOutActive(false);
  });
});

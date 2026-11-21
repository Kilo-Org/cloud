import { beforeEach, describe, expect, it } from 'vitest';

import {
  isFromCurrentDispatchSession,
  tagDispatchSession,
  tagDispatchSessionAt,
} from '@/lib/auth/dispatch-epoch';
import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';

describe('dispatch epoch', () => {
  beforeEach(() => {
    // The epoch is module-level state; move to a fresh session so a case's tags
    // never depend on how many bumps another case made.
    bumpAuthEpoch();
  });

  it('treats an untagged error as not from the current session', () => {
    expect(isFromCurrentDispatchSession(new Error('refused'))).toBe(false);
    expect(isFromCurrentDispatchSession({ data: { code: 'FORBIDDEN' } })).toBe(false);
  });

  it('accepts an error tagged with the current session', () => {
    const error = new Error('refused');

    tagDispatchSession(error);

    expect(isFromCurrentDispatchSession(error)).toBe(true);
  });

  it('rejects the same error once the session it was tagged with has ended', () => {
    const error = new Error('refused');
    tagDispatchSessionAt(error, currentAuthEpoch());

    bumpAuthEpoch();

    expect(isFromCurrentDispatchSession(error)).toBe(false);
  });

  it('tracks the session per error, not the latest tag', () => {
    const earlier = new Error('refused in the session that ended');
    const later = new Error('refused in the current session');
    const untagged = new Error('never tagged');

    tagDispatchSession(earlier);

    bumpAuthEpoch();

    tagDispatchSession(later);

    expect(isFromCurrentDispatchSession(earlier)).toBe(false);
    expect(isFromCurrentDispatchSession(later)).toBe(true);
    expect(isFromCurrentDispatchSession(untagged)).toBe(false);
  });

  it('ignores non-objects on both sides', () => {
    expect(() => {
      tagDispatchSession(undefined);
    }).not.toThrow();
    expect(() => {
      tagDispatchSession('refused');
    }).not.toThrow();
    expect(() => {
      tagDispatchSessionAt(null, 0);
    }).not.toThrow();

    expect(isFromCurrentDispatchSession(undefined)).toBe(false);
    expect(isFromCurrentDispatchSession(null)).toBe(false);
    expect(isFromCurrentDispatchSession('refused')).toBe(false);
  });
});

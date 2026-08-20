import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetDevSessionInjectForTests,
  consumePendingDevSession,
  parseDevSessionQuery,
  subscribePendingDevSession,
  takeDevSessionFromUrl,
} from './dev-session-inject';

const URL =
  'kiloapp:///home?dev_session_token=tok&dev_session_refresh=ref&dev_session_expires_in=3600';

describe('dev-session-inject', () => {
  beforeEach(() => {
    _resetDevSessionInjectForTests();
    vi.stubGlobal('__DEV__', true);
  });

  afterEach(() => {
    _resetDevSessionInjectForTests();
    vi.unstubAllGlobals();
  });

  it('parses a complete query in a dev build', () => {
    expect(parseDevSessionQuery(URL)).toEqual({
      token: 'tok',
      refreshToken: 'ref',
      expiresIn: 3600,
    });
  });

  it('ignores an incomplete query', () => {
    expect(parseDevSessionQuery('kiloapp:///home?dev_session_token=tok')).toBeNull();
  });

  it('is a no-op outside a dev build', () => {
    vi.stubGlobal('__DEV__', false);
    expect(parseDevSessionQuery(URL)).toBeNull();
    takeDevSessionFromUrl(URL);
    expect(consumePendingDevSession()).toBeNull();
  });

  it('notifies a subscriber and is single-shot', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePendingDevSession(() => {
      listener();
    });
    takeDevSessionFromUrl(URL);
    expect(listener).toHaveBeenCalledOnce();
    expect(consumePendingDevSession()).toEqual({
      token: 'tok',
      refreshToken: 'ref',
      expiresIn: 3600,
    });
    expect(consumePendingDevSession()).toBeNull();
    unsubscribe();
  });
});

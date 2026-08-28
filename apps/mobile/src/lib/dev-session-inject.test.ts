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

  it('publishes a paired request once and supports credential-only URLs', () => {
    const observed: ReturnType<typeof consumePendingDevSession>[] = [];
    const unsubscribe = subscribePendingDevSession(() => {
      observed.push(consumePendingDevSession());
    });
    takeDevSessionFromUrl(
      'kiloapp:///?dev_session_token=tok&dev_session_refresh=ref&dev_session_expires_in=3600'
    );
    expect(observed.filter(Boolean)).toEqual([
      {
        id: 1,
        href: '/(app)/(tabs)/(0_home)',
        credentials: { token: 'tok', refreshToken: 'ref', expiresIn: 3600 },
      },
    ]);
    expect(consumePendingDevSession()).toBeNull();
    unsubscribe();
  });

  it('deduplicates cold delivery after consumption but admits a later warm request', () => {
    takeDevSessionFromUrl(URL, '/(app)/(tabs)/(0_home)', true);
    expect(consumePendingDevSession()?.id).toBe(1);
    takeDevSessionFromUrl(URL, '/(app)/(tabs)/(0_home)', true);
    expect(consumePendingDevSession()).toBeNull();
    takeDevSessionFromUrl(URL, '/(app)/(tabs)/(0_home)', false);
    expect(consumePendingDevSession()?.id).toBe(2);
  });

  it('keeps only the latest waiting credential and its destination', () => {
    takeDevSessionFromUrl(URL, '/(app)/(tabs)/(0_home)');
    const first = consumePendingDevSession();
    takeDevSessionFromUrl(URL.replace('token=tok', 'token=second'), '/(app)/agent-chat/ses_2');
    takeDevSessionFromUrl(URL.replace('token=tok', 'token=latest'), '/(app)/(tabs)/(2_agents)');
    expect(first?.href).toBe('/(app)/(tabs)/(0_home)');
    expect(consumePendingDevSession()).toEqual({
      id: 3,
      credentials: { token: 'latest', refreshToken: 'ref', expiresIn: 3600 },
      href: '/(app)/(tabs)/(2_agents)',
    });
    expect(consumePendingDevSession()).toBeNull();
  });
});

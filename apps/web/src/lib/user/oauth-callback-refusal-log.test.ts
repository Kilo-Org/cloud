import type * as NextServer from 'next/server';
import type * as ConfigServer from '@kilocode/web-shared/lib/config.server';

// Outside tests, work scheduled after the response runs through Next's
// `after()`; collect it so the test runs it the way the runtime does.
const mockAfterTasks: Array<() => unknown> = [];
jest.mock('next/server', () => ({
  ...jest.requireActual<typeof NextServer>('next/server'),
  after: (task: () => unknown) => {
    mockAfterTasks.push(task);
  },
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<typeof ConfigServer>('@kilocode/web-shared/lib/config.server'),
  IS_IN_AUTOMATED_TEST: false,
}));
jest.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.7' }),
  cookies: jest.fn(),
}));

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { authOptions } from '@/lib/user/next-auth-options';
import { setAuthActionSinkForTest, type AuthActionEvent } from '@/lib/auth/auth-audit';

describe('an OAuth callback refusal outside tests', () => {
  let events: AuthActionEvent[];

  beforeEach(() => {
    mockAfterTasks.length = 0;
    events = [];
    setAuthActionSinkForTest(event => events.push(event));
  });

  afterEach(() => {
    setAuthActionSinkForTest(null);
  });

  it('emits its log line from work the runtime keeps alive after the response', async () => {
    authOptions.logger?.error?.('OAUTH_CALLBACK_ERROR', {
      providerId: 'github',
      error: new Error('state mismatch'),
    } as never);

    expect(mockAfterTasks).toHaveLength(1);
    await Promise.all(mockAfterTasks.map(task => task()));

    expect(events).toEqual([
      expect.objectContaining({
        action: 'auth.sign_in',
        outcome: 'failure',
        method: 'github',
        failureReason: 'oauth_callback_error',
        stored: false,
        ip: '203.0.113.7',
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('state mismatch');
  });
});

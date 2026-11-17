import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import type * as UserServer from '@kilocode/web-shared/lib/user/server';
import type * as FindUserById from '@kilocode/web-shared/lib/user/find-user-by-id';
import type * as DomainGates from '@kilocode/web-shared/lib/user/domain-gates';
import type * as AppShellFlow from '@/lib/integrations/oauth/app-shell-flow';
import type * as CommonModule from './common';
import { shellUser } from '@/tests/helpers/shell-user.helper';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-actor-signing-secret',
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => ({ findUserById: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/user/domain-gates', () => ({
  isUserBlacklistedByDomain: jest.fn(),
}));
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/trial-middleware', () => ({
  requireActiveSubscriptionOrTrial: jest.fn(),
}));

// This repo's transform does not hoist `jest.mock` above the static imports, so
// the mocked modules and the module under test are required here, after the
// mocks are registered.
const { getUserFromAuth } = jest.requireMock<typeof UserServer>(
  '@kilocode/web-shared/lib/user/server'
);
const { findUserById } = jest.requireMock<typeof FindUserById>(
  '@kilocode/web-shared/lib/user/find-user-by-id'
);
const { isUserBlacklistedByDomain } = jest.requireMock<typeof DomainGates>(
  '@kilocode/web-shared/lib/user/domain-gates'
);
const { createAppShellFlowToken } = jest.requireActual<typeof AppShellFlow>(
  '@/lib/integrations/oauth/app-shell-flow'
);
const { resolveOAuthCallbackActor } = jest.requireActual<typeof CommonModule>('./common');

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockFindUserById = jest.mocked(findUserById);
const mockIsUserBlacklistedByDomain = jest.mocked(isUserBlacklistedByDomain);

const USER_ID = 'user-1';
const RAW_STATE = 'signed-state-for-this-attempt';
const VERIFIED = { userId: USER_ID, appShell: true };

function callbackRequest(cookie?: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/integrations/slack/callback?state=${RAW_STATE}`,
    { headers: cookie ? { cookie } : undefined }
  );
}

function flowCookie(): string {
  return `kilo_app_shell_flow=${createAppShellFlowToken({ userId: USER_ID, state: RAW_STATE })}`;
}

beforeEach(() => {
  jest.resetAllMocks();
  // The in-app browser has no web session: only the shell's state and its flow
  // cookie can identify the caller.
  mockGetUserFromAuth.mockResolvedValue({ user: null, authFailedResponse: null } as never);
  mockIsUserBlacklistedByDomain.mockResolvedValue(false);
});

describe('resolveOAuthCallbackActor', () => {
  test('accepts an active account named by shell state plus the matching flow cookie', async () => {
    mockFindUserById.mockResolvedValue(shellUser(USER_ID));

    const actor = await resolveOAuthCallbackActor({
      request: callbackRequest(flowCookie()),
      rawState: RAW_STATE,
      verified: VERIFIED,
    });

    expect(actor).toMatchObject({ status: 'app_shell', user: { id: USER_ID } });
  });

  test('refuses an account blocked after the state was minted', async () => {
    mockFindUserById.mockResolvedValue({
      ...shellUser(USER_ID),
      blocked_at: '2026-01-02T00:00:00.000Z',
    });

    await expect(
      resolveOAuthCallbackActor({
        request: callbackRequest(flowCookie()),
        rawState: RAW_STATE,
        verified: VERIFIED,
      })
    ).resolves.toEqual({ status: 'unauthenticated' });
  });

  test('refuses an account on a blocklisted email domain', async () => {
    mockFindUserById.mockResolvedValue(shellUser(USER_ID));
    mockIsUserBlacklistedByDomain.mockResolvedValue(true);

    await expect(
      resolveOAuthCallbackActor({
        request: callbackRequest(flowCookie()),
        rawState: RAW_STATE,
        verified: VERIFIED,
      })
    ).resolves.toEqual({ status: 'unauthenticated' });
  });

  test('refuses shell state without the flow cookie', async () => {
    mockFindUserById.mockResolvedValue(shellUser(USER_ID));

    await expect(
      resolveOAuthCallbackActor({
        request: callbackRequest(),
        rawState: RAW_STATE,
        verified: VERIFIED,
      })
    ).resolves.toEqual({ status: 'unauthenticated' });
    expect(mockFindUserById).not.toHaveBeenCalled();
  });
});

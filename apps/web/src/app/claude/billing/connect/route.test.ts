jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/claude-billing/profile', () => ({ ensureClaudeBillingProfile: jest.fn() }));
jest.mock('@/lib/claude-billing/pending', () => ({ saveClaudeBillingPending: jest.fn() }));
jest.mock('@/lib/claude-billing/protocol', () => ({
  pushClaudeAuthorizationRequest: jest.fn(),
}));
jest.mock('@/lib/claude-billing/access', () => ({
  canManageClaudeBillingOrganization: jest.fn(),
}));

import { beforeEach, describe, expect, it } from '@jest/globals';
import { NextRequest } from 'next/server';
import { ClaudeBillingLockBusyError } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ensureClaudeBillingProfile } from '@/lib/claude-billing/profile';
import { saveClaudeBillingPending } from '@/lib/claude-billing/pending';
import { pushClaudeAuthorizationRequest } from '@/lib/claude-billing/protocol';
import { canManageClaudeBillingOrganization } from '@/lib/claude-billing/access';
import { GET } from './route';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000002';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize?client_id=test-client';

const authorized = {
  user: defineTestUser({ id: USER_ID }),
  authFailedResponse: null,
  // Authorized, so the auth result's refusal flag stays unset.
  authorizationRefused: undefined,
};

function connect(query = 'return=%2Fbyok') {
  return GET(new NextRequest(`http://localhost:3000/claude/billing/connect?${query}`));
}

beforeEach(() => {
  jest.mocked(getUserFromAuth).mockReset().mockResolvedValue(authorized);
  jest.mocked(ensureClaudeBillingProfile).mockReset().mockResolvedValue({
    userProfileId: 'uprof_test',
    connectionVersion: '2026-09-16T12:00:00.000Z',
  });
  jest.mocked(saveClaudeBillingPending).mockReset().mockResolvedValue(undefined);
  jest.mocked(pushClaudeAuthorizationRequest).mockReset().mockResolvedValue(AUTHORIZE_URL);
  jest.mocked(canManageClaudeBillingOrganization).mockReset().mockResolvedValue(true);
});

describe('Claude billing connect route', () => {
  it('reports a personal lock conflict as a transient busy outcome', async () => {
    jest
      .mocked(ensureClaudeBillingProfile)
      .mockRejectedValue(new ClaudeBillingLockBusyError('claude_billing_grant:x'));

    const response = await connect();

    const url = new URL(response.headers.get('location') ?? '');
    expect(url.pathname).toBe('/byok');
    expect(url.searchParams.get('claude_billing')).toBe('busy');
    expect(pushClaudeAuthorizationRequest).not.toHaveBeenCalled();
    expect(saveClaudeBillingPending).not.toHaveBeenCalled();
  });

  it('reports an organization lock conflict under the organization outcome', async () => {
    jest
      .mocked(ensureClaudeBillingProfile)
      .mockRejectedValue(new ClaudeBillingLockBusyError('claude_billing_grant:x'));

    const response = await connect(`owner=${ORGANIZATION_ID}&return=%2Fbyok`);

    expect(canManageClaudeBillingOrganization).toHaveBeenCalledWith(USER_ID, ORGANIZATION_ID);
    const url = new URL(response.headers.get('location') ?? '');
    expect(url.searchParams.get('claude_billing_organization')).toBe('busy');
    expect(url.searchParams.get('claude_billing_organization')).not.toBe('failed');
  });

  it('reports a provider error as a failed outcome', async () => {
    const providerError = Object.assign(new Error('provider unavailable'), { status: 500 });
    jest.mocked(ensureClaudeBillingProfile).mockRejectedValue(providerError);
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await connect();

      const url = new URL(response.headers.get('location') ?? '');
      expect(url.searchParams.get('claude_billing')).toBe('failed');
    } finally {
      log.mockRestore();
    }
  });

  it('redirects to the provider authorization page on success', async () => {
    const response = await connect();

    expect(response.headers.get('location')).toBe(AUTHORIZE_URL);
    expect(saveClaudeBillingPending).toHaveBeenCalledTimes(1);
  });
});

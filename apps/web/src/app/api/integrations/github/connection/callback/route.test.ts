import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { consumeGitHubConnectionOAuthState } from '@/lib/integrations/github/connection-state';
import {
  completeGitHubConnectionAttempt,
  recordGitHubConnectionDiscovery,
} from '@/lib/integrations/github/connection-service';
import { exchangeGitHubOAuthCode } from '@/lib/integrations/platforms/github/adapter';
import {
  discoverAuthorizedGitHubInstallations,
  verifyGitHubInstallationAuthorization,
} from '@/lib/integrations/github/installation-authorization';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

jest.mock('@/lib/user/server');
jest.mock('@/lib/integrations/github/connection-state');
jest.mock('@/lib/integrations/github/connection-service');
jest.mock('@/lib/integrations/platforms/github/adapter');
jest.mock('@/lib/integrations/github/installation-authorization');
jest.mock('@/routers/organizations/utils');
jest.mock('@/lib/integrations/github/multiple-installations', () => ({
  isGitHubConnectionManagementEnabled: () => true,
}));
jest.mock('@/lib/integrations/platforms/github/app-selector', () => ({
  getGitHubAppCredentials: () => ({ appId: '7' }),
}));

const attemptId = '00000000-0000-4000-8000-000000000001';
const organizationId = '00000000-0000-4000-8000-000000000002';
const candidate = {
  installationId: '44',
  accountId: '99',
  accountLogin: 'acme',
  accountType: 'Organization' as const,
};
const attempt = {
  id: attemptId,
  kilo_user_id: 'oauth/user',
  owner_type: 'org' as const,
  owner_id: organizationId,
  github_app_type: 'standard' as const,
  selected_installation_id: '44',
  github_user_id: '12',
  eligible_installations: [candidate],
  completed_integration_id: null,
  return_to: null,
  expires_at: '2099-01-01T00:00:00.000Z',
  consumed_at: null,
  created_at: '2026-09-05T00:00:00.000Z',
};

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [attempt] }),
      }),
    }),
  },
}));

const mockedGetUser = jest.mocked(getUserFromAuth);
const mockedConsumeState = jest.mocked(consumeGitHubConnectionOAuthState);
const mockedExchange = jest.mocked(exchangeGitHubOAuthCode);
const mockedDiscover = jest.mocked(discoverAuthorizedGitHubInstallations);
const mockedVerify = jest.mocked(verifyGitHubInstallationAuthorization);
const mockedRecordDiscovery = jest.mocked(recordGitHubConnectionDiscovery);
const mockedComplete = jest.mocked(completeGitHubConnectionAttempt);
const mockedEnsureOrganizationAccess = jest.mocked(ensureOrganizationAccess);

beforeEach(() => {
  jest.resetAllMocks();
  mockedGetUser.mockResolvedValue({
    user: { id: 'oauth/user' },
    authFailedResponse: null,
  } as never);
  mockedExchange.mockResolvedValue({ id: '12', login: 'owner', accessToken: 'token' });
  mockedEnsureOrganizationAccess.mockResolvedValue('admin');
});

test('records only server-authorized discovery candidates', async () => {
  mockedConsumeState.mockResolvedValue({
    attemptId,
    stage: 'discover',
    verifierRef: 'ref',
    codeVerifier: 'verifier',
  });
  mockedDiscover.mockResolvedValue({
    identity: { id: '12', login: 'owner' },
    candidates: [candidate],
  });
  const { GET } = await import('./route');
  const response = await GET(
    new NextRequest(`http://localhost/callback?state=state&code=code`) as never
  );
  expect(mockedRecordDiscovery).toHaveBeenCalledWith({
    attemptId,
    userId: 'oauth/user',
    githubUserId: '12',
    candidates: [candidate],
  });
  expect(response.headers.get('location')).toContain(`github_connection_attempt=${attemptId}`);
});

test('rechecks GitHub and Kilo authority before completing confirmation', async () => {
  mockedConsumeState.mockResolvedValue({
    attemptId,
    stage: 'confirm',
    verifierRef: 'ref',
    codeVerifier: 'verifier',
  });
  mockedVerify.mockResolvedValue({ identity: { id: '12', login: 'owner' }, candidate });
  mockedComplete.mockImplementation(async input => {
    await input.authorizeOwner({ type: 'org', id: organizationId });
    return { ok: true, integrationId: '00000000-0000-4000-8000-000000000003' };
  });
  const { GET } = await import('./route');
  const response = await GET(
    new NextRequest(`http://localhost/callback?state=state&code=code`) as never
  );
  expect(mockedEnsureOrganizationAccess).toHaveBeenCalledTimes(2);
  expect(response.headers.get('location')).toContain('github_connection=success');
});

test('fails closed when destination administration was revoked', async () => {
  mockedConsumeState.mockResolvedValue({
    attemptId,
    stage: 'confirm',
    verifierRef: 'ref',
    codeVerifier: 'verifier',
  });
  mockedEnsureOrganizationAccess.mockRejectedValue(new Error('revoked'));
  const { GET } = await import('./route');
  const response = await GET(
    new NextRequest(`http://localhost/callback?state=state&code=code`) as never
  );
  expect(mockedExchange).not.toHaveBeenCalled();
  expect(response.headers.get('location')).toContain(
    'github_connection_error=authorization_revoked'
  );
});

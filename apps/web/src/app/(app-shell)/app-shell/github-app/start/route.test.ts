import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { TRPCError } from '@trpc/server';
import type * as SessionModule from '@/lib/app-shell/session';
import type * as InstallStartModule from '@/lib/integrations/github/install-start';
import type * as StartRouteModule from './route';
import { shellUser } from '@/tests/helpers/shell-user.helper';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-install-start-signing-secret',
}));
jest.mock('@/lib/app-shell/session', () => ({ requireAppShellUser: jest.fn() }));
jest.mock('@/lib/integrations/github/install-start', () => ({
  beginGitHubAppInstall: jest.fn(),
  buildGitHubAppInstallUrl: jest.fn(),
}));

// This repo's transform does not hoist `jest.mock` above the static imports, so
// the mocked modules and the module under test are required here, after the
// mocks are registered.
const { requireAppShellUser } = jest.requireMock<typeof SessionModule>('@/lib/app-shell/session');
const { beginGitHubAppInstall, buildGitHubAppInstallUrl } = jest.requireMock<
  typeof InstallStartModule
>('@/lib/integrations/github/install-start');
const { GET } = jest.requireActual<typeof StartRouteModule>('./route');

const mockRequireUser = jest.mocked(requireAppShellUser);
const mockBeginInstall = jest.mocked(beginGitHubAppInstall);
const mockBuildInstallUrl = jest.mocked(buildGitHubAppInstallUrl);

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';

function startRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/app-shell/github-app/start${query}`);
}

beforeEach(() => {
  jest.resetAllMocks();
  mockRequireUser.mockResolvedValue(shellUser('user-1'));
  mockBeginInstall.mockResolvedValue({ token: 'install-state', appType: 'standard' });
  mockBuildInstallUrl.mockReturnValue(
    'https://github.com/apps/kilo/installations/new?state=install-state'
  );
});

describe('GET /app-shell/github-app/start', () => {
  test('refuses an organization id the page could not resolve', async () => {
    const response = await GET(startRequest('?organizationId=not-a-uuid'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      '/app-shell/github-app?error=installation_start_refused'
    );
    expect(mockBeginInstall).not.toHaveBeenCalled();
  });

  test('starts an organization install for a well-formed id', async () => {
    const response = await GET(startRequest(`?organizationId=${ORGANIZATION_ID}`));

    expect(mockBeginInstall).toHaveBeenCalledWith(
      { user: expect.objectContaining({ id: 'user-1' }) },
      {
        organizationId: ORGANIZATION_ID,
        returnTo: `/app-shell/github-app?organizationId=${ORGANIZATION_ID}`,
      }
    );
    expect(response.headers.get('location')).toContain('github.com/apps');
  });

  test('keeps the organization context when the caller may not start the install', async () => {
    mockBeginInstall.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'Organization role required' })
    );

    const response = await GET(startRequest(`?organizationId=${ORGANIZATION_ID}`));

    expect(response.headers.get('location')).toBe(
      `/app-shell/github-app?error=installation_start_refused&organizationId=${ORGANIZATION_ID}`
    );
  });
});

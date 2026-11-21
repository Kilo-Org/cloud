import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { TRPCError } from '@trpc/server';
import type * as SessionModule from '@/lib/app-shell/session';
import type * as RoutesModule from '@/lib/integrations/oauth/routes';
import type * as ConnectRouteModule from './route';
import { shellUser } from '@/tests/helpers/shell-user.helper';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => ({ findUserById: jest.fn() }));
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/trial-middleware', () => ({
  requireActiveSubscriptionOrTrial: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/app-shell/session', () => ({ requireAppShellUser: jest.fn() }));
jest.mock('@/lib/integrations/oauth/routes', () => ({
  handlePlatformOAuthConnectForAppShell: jest.fn(),
  handlePlatformOAuthConnectPostForAppShell: jest.fn(),
}));

// This repo's transform does not hoist `jest.mock` above the static imports, so
// the mocked modules and the module under test are required here, after the
// mocks are registered.
const { requireAppShellUser } = jest.requireMock<typeof SessionModule>('@/lib/app-shell/session');
const { handlePlatformOAuthConnectForAppShell } = jest.requireMock<typeof RoutesModule>(
  '@/lib/integrations/oauth/routes'
);
const { GET } = jest.requireActual<typeof ConnectRouteModule>('./route');

const mockRequireUser = jest.mocked(requireAppShellUser);
const mockConnect = jest.mocked(handlePlatformOAuthConnectForAppShell);

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';

function connectRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/app-shell/connect/slack${query}`);
}

function routeContext(platform: string) {
  return { params: Promise.resolve({ platform }) };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockRequireUser.mockResolvedValue(shellUser('user-1'));
});

describe('GET /app-shell/connect/[platform]', () => {
  test('sends an aborted organization connect to the shell page that owns it', async () => {
    mockConnect.mockRejectedValue(
      new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You do not have access to this organization',
      })
    );

    const response = await GET(
      connectRequest(`?organizationId=${ORGANIZATION_ID}`),
      routeContext('slack')
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      `/app-shell/organizations/${ORGANIZATION_ID}/integrations/slack?error=organization_access_required`
    );
  });

  test('sends any other start failure to the shell page as its error outcome', async () => {
    mockConnect.mockRejectedValue(new Error('provider configuration missing'));

    const response = await GET(connectRequest(), routeContext('slack'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      '/app-shell/integrations/slack?error=oauth_init_failed'
    );
  });

  test('sends a browser with no shell session to the terminal page', async () => {
    mockRequireUser.mockResolvedValue(null);

    const response = await GET(connectRequest(), routeContext('slack'));

    expect(response.headers.get('location')).toBe('/app-shell/expired');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  test('refuses a provider the shell does not host', async () => {
    const response = await GET(connectRequest(), routeContext('bitbucket'));

    expect(response.status).toBe(404);
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

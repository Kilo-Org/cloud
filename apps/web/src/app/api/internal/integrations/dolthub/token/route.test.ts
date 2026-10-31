const mockConfig: { dedicated: string; shared: string } = {
  dedicated: 'wasteland-dolthub-secret',
  shared: 'platform-internal-secret',
};
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  get WASTELAND_DOLTHUB_TOKEN_SECRET() {
    return mockConfig.dedicated;
  },
  get INTERNAL_API_SECRET() {
    return mockConfig.shared;
  },
}));
jest.mock('@/lib/integrations/dolthub-service', () => ({
  getInstallation: jest.fn(),
  getValidDoltHubToken: jest.fn(),
  getCachedDoltHubUsername: jest.fn(),
}));

import { NextRequest } from 'next/server';
import type { PlatformIntegration } from '@kilocode/db/schema';
import * as dolthubService from '@/lib/integrations/dolthub-service';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';
import { POST } from './route';

const mockedGetInstallation = jest.mocked(dolthubService.getInstallation);
const mockedGetValidToken = jest.mocked(dolthubService.getValidDoltHubToken);
const mockedGetUsername = jest.mocked(dolthubService.getCachedDoltHubUsername);

const USER_ID = 'oauth/user-dolthub';
const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000aa';
const ACCESS_TOKEN = 'dhat.v1.e2e-access-token';

function request(
  body: unknown = { userId: USER_ID },
  headers: Record<string, string> = { authorization: `Bearer ${mockConfig.dedicated}` }
): NextRequest {
  return new NextRequest('https://app.example.test/api/internal/integrations/dolthub/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function integration(
  status: PlatformIntegration['integration_status'] = INTEGRATION_STATUS.ACTIVE
): PlatformIntegration {
  return { id: INTEGRATION_ID, integration_status: status } as unknown as PlatformIntegration;
}

let consoleInfo: jest.SpiedFunction<typeof console.info>;

beforeEach(() => {
  mockConfig.dedicated = 'wasteland-dolthub-secret';
  mockedGetInstallation.mockReset();
  mockedGetValidToken.mockReset();
  mockedGetUsername.mockReset();
  mockedGetInstallation.mockResolvedValue(integration());
  mockedGetValidToken.mockResolvedValue(ACCESS_TOKEN);
  mockedGetUsername.mockReturnValue('dolthub-user');
  consoleInfo = jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  consoleInfo.mockRestore();
});

describe('POST /api/internal/integrations/dolthub/token authorization', () => {
  it('issues the token for the owner to the dedicated caller credential', async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token: ACCESS_TOKEN,
      dolthubUsername: 'dolthub-user',
    });
    expect(mockedGetInstallation).toHaveBeenCalledWith({ type: 'user', id: USER_ID });
  });

  it('records which owner the token was issued for, without the credential', async () => {
    await POST(request());

    const issuance = consoleInfo.mock.calls.filter(
      ([message]) => message === '[dolthub-internal-token] issued'
    );
    expect(issuance).toHaveLength(1);
    expect(issuance[0][1]).toEqual({
      caller: 'wasteland',
      ownerType: 'user',
      ownerId: USER_ID,
      integrationId: INTEGRATION_ID,
    });
    expect(JSON.stringify(consoleInfo.mock.calls)).not.toContain(ACCESS_TOKEN);
  });

  it.each([
    ['no authorization header', {}],
    ['the platform-wide internal secret', { authorization: `Bearer ${mockConfig.shared}` }],
    [
      'the platform-wide internal secret in the old header',
      { 'X-Internal-Secret': mockConfig.shared },
    ],
    [
      'the platform-wide internal secret as a bare key header',
      { 'X-Internal-Api-Key': mockConfig.shared },
    ],
    ['a wrong secret', { authorization: 'Bearer not-the-secret' }],
    ['a non-bearer scheme', { authorization: `Basic ${mockConfig.dedicated}` }],
  ])('rejects %s', async (_label, headers) => {
    const response = await POST(request(undefined, headers));

    expect(response.status).toBe(401);
    expect(mockedGetInstallation).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
  });

  it('rejects every caller when the dedicated secret is not configured', async () => {
    mockConfig.dedicated = '';

    const response = await POST(request(undefined, { authorization: 'Bearer ' }));

    expect(response.status).toBe(401);
    expect(mockedGetInstallation).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/integrations/dolthub/token request body', () => {
  it.each([
    ['an organization owner', { organizationId: 'org-1' }],
    ['a user and an organization', { userId: USER_ID, organizationId: 'org-1' }],
    ['an unknown field', { userId: USER_ID, ownerType: 'user' }],
    ['an empty user id', { userId: '' }],
    ['no owner', {}],
  ])('rejects %s with 400', async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(mockedGetInstallation).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON body with 400', async () => {
    const response = await POST(request('not json'));

    expect(response.status).toBe(400);
    expect(mockedGetInstallation).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/integrations/dolthub/token outcomes', () => {
  it('answers 404 when the user has no DoltHub integration', async () => {
    mockedGetInstallation.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mockedGetValidToken).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
  });

  it('answers 409 when the integration is not active', async () => {
    mockedGetInstallation.mockResolvedValue(integration(INTEGRATION_STATUS.SUSPENDED));

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(mockedGetValidToken).not.toHaveBeenCalled();
  });

  it('answers 409 when no usable token remains', async () => {
    mockedGetValidToken.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(consoleInfo).not.toHaveBeenCalled();
  });

  it('answers 502 when the refresh fails', async () => {
    mockedGetValidToken.mockRejectedValue(new Error('refresh rejected'));

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect(consoleInfo).not.toHaveBeenCalled();
  });
});

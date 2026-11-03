import * as React from 'react';
import { redirect } from 'next/navigation';
import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import DeviceAuthPage from './page';

// @swc/jest compiles JSX with the classic runtime, and the page imports no
// React default, so its `React.createElement` calls need React on the global.
Object.assign(globalThis, { React });

jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuthOrRedirect: jest.fn(),
}));

jest.mock('@/lib/device-auth/device-auth-viewer-token', () => ({
  createDeviceAuthViewerToken: jest.fn(),
}));

jest.mock('@/lib/device-auth/device-auth', () => ({
  getDeviceAuthRequest: jest.fn(),
  isDeviceAuthRequestExpired: jest.fn(),
}));

const requestedClient = {
  requesting_client_id: 'client-abc',
  requesting_client_name: 'Claude Desktop',
  requesting_redirect_origin: 'https://client.test',
  status: 'pending',
  expires_at: new Date(Date.now() + 600_000).toISOString(),
};

const mockedRedirect = jest.mocked(redirect);
const mockedGetUserFromAuthOrRedirect = jest.mocked(getUserFromAuthOrRedirect);
const { getDeviceAuthRequest, isDeviceAuthRequestExpired } = jest.requireMock(
  '@/lib/device-auth/device-auth'
) as {
  getDeviceAuthRequest: jest.Mock;
  isDeviceAuthRequestExpired: jest.Mock;
};

describe('DeviceAuthPage missing code handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([{}, { code: '' }, { code: '   ' }])(
    'redirects malformed device-auth links without authenticating: %j',
    async searchParams => {
      await DeviceAuthPage({ searchParams: Promise.resolve(searchParams) });

      expect(mockedRedirect).toHaveBeenCalledWith('/');
      expect(mockedGetUserFromAuthOrRedirect).not.toHaveBeenCalled();
    }
  );
});

describe('DeviceAuthPage requesting client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuthOrRedirect.mockResolvedValue({
      id: 'user-1',
      google_user_name: 'Ada Lovelace',
      google_user_email: 'ada@kilo.test',
      google_user_image_url: '',
    } as never);
  });

  test('hands the approval page the client the request names', async () => {
    getDeviceAuthRequest.mockResolvedValue(requestedClient);
    isDeviceAuthRequestExpired.mockReturnValue(false);

    const element = (await DeviceAuthPage({
      searchParams: Promise.resolve({ code: 'ABCD-1234' }),
    })) as { props: { requestingClient: unknown } };

    expect(element.props.requestingClient).toEqual({
      clientId: 'client-abc',
      clientName: 'Claude Desktop',
      redirectOrigin: 'https://client.test',
    });
  });

  test('hands no client for a request that names none', async () => {
    getDeviceAuthRequest.mockResolvedValue({
      ...requestedClient,
      requesting_client_id: null,
      requesting_client_name: null,
      requesting_redirect_origin: null,
    });
    isDeviceAuthRequestExpired.mockReturnValue(false);

    const element = (await DeviceAuthPage({
      searchParams: Promise.resolve({ code: 'ABCD-1234' }),
    })) as { props: { requestingClient: unknown } };

    expect(element.props.requestingClient).toBeNull();
  });

  test('hands no client for a request that can no longer be approved', async () => {
    getDeviceAuthRequest.mockResolvedValue(requestedClient);
    isDeviceAuthRequestExpired.mockReturnValue(true);

    const element = (await DeviceAuthPage({
      searchParams: Promise.resolve({ code: 'ABCD-1234' }),
    })) as { props: { requestingClient: unknown } };

    expect(element.props.requestingClient).toBeNull();
  });
});

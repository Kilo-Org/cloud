import { redirect } from 'next/navigation';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import DeviceAuthPage from './page';

jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
}));

jest.mock('@/lib/user/server', () => ({
  getUserFromAuthOrRedirect: jest.fn(),
}));

jest.mock('@/lib/device-auth/device-auth-viewer-token', () => ({
  createDeviceAuthViewerToken: jest.fn(),
}));

const mockedRedirect = jest.mocked(redirect);
const mockedGetUserFromAuthOrRedirect = jest.mocked(getUserFromAuthOrRedirect);

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

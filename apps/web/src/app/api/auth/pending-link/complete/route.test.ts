import { APP_URL } from '@kilocode/web-shared/lib/constants';

jest.mock('@/lib/auth/pending-link', () => ({
  clearPendingLinkCookie: jest.fn(),
  completePendingLink: jest.fn(),
  getPendingLinkBySecret: jest.fn(),
  isPendingLinkLive: jest.fn(),
  pendingLinkPageUrl: '/users/pending-link',
  readPendingLinkSecret: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromSessionForCredentialIssuance: jest.fn(),
}));

import { GET, POST } from './route';
import {
  clearPendingLinkCookie,
  completePendingLink,
  getPendingLinkBySecret,
  isPendingLinkLive,
  readPendingLinkSecret,
} from '@/lib/auth/pending-link';
import { getUserFromSessionForCredentialIssuance } from '@kilocode/web-shared/lib/user/server';

const mockReadSecret = jest.mocked(readPendingLinkSecret);
const mockGetPending = jest.mocked(getPendingLinkBySecret);
const mockComplete = jest.mocked(completePendingLink);
const mockClearCookie = jest.mocked(clearPendingLinkCookie);
const mockIsLive = jest.mocked(isPendingLinkLive);
const mockSession = jest.mocked(getUserFromSessionForCredentialIssuance);

const liveRow = {
  id: 'pending-1',
  kilo_user_id: 'user-1',
  kind: 'existing_account',
  provider: 'github',
  callback_path: null,
} as never;

const appOrigin = new URL(APP_URL).origin;
const completeUrl = 'http://localhost:3000/api/auth/pending-link/complete';
const appHost = new URL(completeUrl).host;

describe('/api/auth/pending-link/complete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadSecret.mockResolvedValue('secret-1');
    mockGetPending.mockResolvedValue(liveRow);
    mockSession.mockResolvedValue({ user: { id: 'user-1' } } as never);
    mockIsLive.mockResolvedValue(true);
  });

  it('GET attaches nothing and redirects to the confirmation page', async () => {
    const response = await GET(new Request(completeUrl));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/users/pending-link?confirm=1');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('GET without a session redirects with SESSION_REQUIRED', async () => {
    mockSession.mockResolvedValue({ user: null } as never);

    const response = await GET(new Request(completeUrl));

    expect(response.headers.get('location')).toContain('error=SESSION_REQUIRED');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('GET with another account signed in redirects with WRONG_ACCOUNT', async () => {
    mockSession.mockResolvedValue({ user: { id: 'someone-else' } } as never);

    const response = await GET(new Request(completeUrl));

    expect(response.headers.get('location')).toContain('error=WRONG_ACCOUNT');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('POST refuses a foreign Origin without attaching', async () => {
    const response = await POST(
      new Request(completeUrl, {
        method: 'POST',
        headers: { Origin: 'https://evil.example', Host: appHost },
      })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'INVALID_ORIGIN' });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('POST without a session answers SESSION_REQUIRED', async () => {
    mockSession.mockResolvedValue({ user: null } as never);

    const response = await POST(
      new Request(completeUrl, { method: 'POST', headers: { Origin: appOrigin, Host: appHost } })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'SESSION_REQUIRED' });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('POST reports a session mismatch as WRONG_ACCOUNT', async () => {
    mockSession.mockResolvedValue({ user: { id: 'someone-else' } } as never);
    mockComplete.mockResolvedValue({ status: 'failed', reason: 'WRONG_ACCOUNT' });

    const response = await POST(
      new Request(completeUrl, { method: 'POST', headers: { Origin: appOrigin, Host: appHost } })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'WRONG_ACCOUNT' });
    expect(mockClearCookie).not.toHaveBeenCalled();
  });

  it('POST attaches and returns the redirect target', async () => {
    mockComplete.mockResolvedValue({ status: 'linked', provider: 'github' });

    const response = await POST(
      new Request(completeUrl, { method: 'POST', headers: { Origin: appOrigin, Host: appHost } })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: '/users/after-sign-in' });
    expect(mockComplete).toHaveBeenCalledWith('secret-1', 'user-1');
    expect(mockClearCookie).toHaveBeenCalled();
  });

  it('POST keeps the cookie when an EXPIRED came from a lost claim race', async () => {
    mockComplete.mockResolvedValue({ status: 'failed', reason: 'EXPIRED' });
    mockIsLive.mockResolvedValue(true);

    const response = await POST(
      new Request(completeUrl, { method: 'POST', headers: { Origin: appOrigin, Host: appHost } })
    );

    expect(response.status).toBe(404);
    expect(mockClearCookie).not.toHaveBeenCalled();
  });

  it('POST clears the cookie when the row is really not live', async () => {
    mockComplete.mockResolvedValue({ status: 'failed', reason: 'EXPIRED' });
    mockIsLive.mockResolvedValue(false);

    const response = await POST(
      new Request(completeUrl, { method: 'POST', headers: { Origin: appOrigin, Host: appHost } })
    );

    expect(response.status).toBe(404);
    expect(mockClearCookie).toHaveBeenCalled();
  });
});

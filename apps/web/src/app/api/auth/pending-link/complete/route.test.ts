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
jest.mock('@/lib/auth/sign-in-method-change', () => ({
  authorizeSignInMethodChange: jest.fn(),
}));
jest.mock('@/lib/auth/sign-in-method-change-email-code', () => ({
  consumeSignInMethodChangeCode: jest.fn(),
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
import { authorizeSignInMethodChange } from '@/lib/auth/sign-in-method-change';
import { consumeSignInMethodChangeCode } from '@/lib/auth/sign-in-method-change-email-code';
import { SIGN_IN_METHOD_CHANGE_REFUSAL_CODES } from '@/lib/auth/sign-in-method-change-codes';

const mockReadSecret = jest.mocked(readPendingLinkSecret);
const mockGetPending = jest.mocked(getPendingLinkBySecret);
const mockComplete = jest.mocked(completePendingLink);
const mockClearCookie = jest.mocked(clearPendingLinkCookie);
const mockIsLive = jest.mocked(isPendingLinkLive);
const mockSession = jest.mocked(getUserFromSessionForCredentialIssuance);
const mockAuthorize = jest.mocked(authorizeSignInMethodChange);
const mockConsumeCode = jest.mocked(consumeSignInMethodChangeCode);

const liveRow = {
  id: 'pending-1',
  kilo_user_id: 'user-1',
  kind: 'existing_account',
  provider: 'github',
  callback_path: null,
} as never;

const explicitRow = {
  id: 'pending-2',
  kilo_user_id: 'user-1',
  kind: 'explicit_link',
  provider: 'apple',
  callback_path: null,
} as never;

const sessionUser = { id: 'user-1', google_user_email: 'owner@example.com' };
const CHALLENGE_ID = '00000000-0000-4000-8000-000000000009';

const appOrigin = new URL(APP_URL).origin;
const completeUrl = 'http://localhost:3000/api/auth/pending-link/complete';
const appHost = new URL(completeUrl).host;

function postComplete(body?: unknown): Promise<Response> {
  return POST(
    new Request(completeUrl, {
      method: 'POST',
      headers: { Origin: appOrigin, Host: appHost, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
}

const codeProof = { code: '123456', challengeId: CHALLENGE_ID };

describe('/api/auth/pending-link/complete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadSecret.mockResolvedValue('secret-1');
    mockGetPending.mockResolvedValue(liveRow);
    mockSession.mockResolvedValue({ user: sessionUser, webSessionId: 'web-session-1' } as never);
    mockIsLive.mockResolvedValue(true);
    mockAuthorize.mockResolvedValue(null);
    mockConsumeCode.mockResolvedValue('ok');
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

    const response = await postComplete(codeProof);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'SESSION_REQUIRED' });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('POST reports a session mismatch as WRONG_ACCOUNT without spending the code', async () => {
    mockSession.mockResolvedValue({
      user: { id: 'someone-else', google_user_email: 'other@example.com' },
      webSessionId: 'web-session-2',
    } as never);

    const response = await postComplete(codeProof);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'WRONG_ACCOUNT' });
    expect(mockConsumeCode).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockClearCookie).not.toHaveBeenCalled();
  });

  // A held session cookie of the account, with a pending link for an identity
  // whose email claim the provider never verified, must not attach it.
  it('POST refuses an existing-account link with a session alone', async () => {
    const response = await postComplete();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid,
    });
    expect(mockConsumeCode).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('POST attaches with the emailed code bound to this browser session', async () => {
    mockComplete.mockResolvedValue({ status: 'linked', provider: 'github' });

    const response = await postComplete(codeProof);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: '/users/after-sign-in' });
    expect(mockConsumeCode).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        email: 'owner@example.com',
        change: 'link',
        provider: 'github',
        webSessionId: 'web-session-1',
      },
      '123456',
      CHALLENGE_ID
    );
    expect(mockComplete).toHaveBeenCalledWith('secret-1', 'user-1');
    expect(mockClearCookie).toHaveBeenCalled();
  });

  it('POST refuses a wrong code without attaching', async () => {
    mockConsumeCode.mockResolvedValue('invalid');

    const response = await postComplete(codeProof);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid,
    });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('POST refuses a locked account without attaching', async () => {
    mockConsumeCode.mockResolvedValue('locked');

    const response = await postComplete(codeProof);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeLocked,
    });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('POST asks a session without a session id to sign in again', async () => {
    mockSession.mockResolvedValue({ user: sessionUser } as never);

    const response = await postComplete(codeProof);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.sessionReauthRequired,
    });
    expect(mockConsumeCode).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('POST refuses a link that the single sign-on policy forbids, without spending the code', async () => {
    mockAuthorize.mockResolvedValue('ssoLinkNotAllowed');

    const response = await postComplete(codeProof);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.ssoLinkNotAllowed,
    });
    expect(mockConsumeCode).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('POST attaches an explicit link without a code, which its start spent', async () => {
    mockGetPending.mockResolvedValue(explicitRow);
    mockComplete.mockResolvedValue({ status: 'linked', provider: 'apple' });

    const response = await postComplete();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: '/connected-accounts?linked=apple' });
    expect(mockConsumeCode).not.toHaveBeenCalled();
  });

  it('POST keeps the cookie when an EXPIRED came from a lost claim race', async () => {
    mockComplete.mockResolvedValue({ status: 'failed', reason: 'EXPIRED' });
    mockIsLive.mockResolvedValue(true);

    const response = await postComplete(codeProof);

    expect(response.status).toBe(404);
    expect(mockClearCookie).not.toHaveBeenCalled();
  });

  it('POST clears the cookie when the row is really not live', async () => {
    mockComplete.mockResolvedValue({ status: 'failed', reason: 'EXPIRED' });
    mockIsLive.mockResolvedValue(false);

    const response = await postComplete(codeProof);

    expect(response.status).toBe(404);
    expect(mockClearCookie).toHaveBeenCalled();
  });
});

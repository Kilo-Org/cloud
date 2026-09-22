import { redirect } from 'next/navigation';
import { getUserFromAuth } from '@/lib/user/server';
import { getAuthPageProps } from './auth-page-wrapper';

jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
}));

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

const mockedRedirect = jest.mocked(redirect);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

type AuthResponse = Awaited<ReturnType<typeof getUserFromAuth>>;

function signedInAs(email: string | null) {
  mockedGetUserFromAuth.mockResolvedValue({
    user: email === null ? null : { google_user_email: email },
  } as unknown as AuthResponse);
}

describe('getAuthPageProps SSO account mismatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not redirect and reports the mismatch when the device sign-in expected email differs', async () => {
    signedInAs('b@example.com');

    const result = await getAuthPageProps(
      Promise.resolve({
        sso: 'true',
        email: 'a@example.com',
        callbackPath: '/device-auth?code=ABC&app=1',
      })
    );

    expect(mockedRedirect).not.toHaveBeenCalled();
    expect(result.accountMismatch).toEqual({
      expectedEmail: 'a@example.com',
      signedInEmail: 'b@example.com',
    });
  });

  it('redirects when the signed-in address matches the requested email exactly', async () => {
    signedInAs('a@example.com');

    await getAuthPageProps(Promise.resolve({ sso: 'true', email: 'a@example.com' }));

    expect(mockedRedirect).toHaveBeenCalledWith(
      '/users/after-sign-in?sso=true&email=a%40example.com'
    );
    expect(mockedRedirect).toHaveBeenCalledTimes(1);
  });

  it('treats a differently-cased or padded address as a match', async () => {
    signedInAs('b@example.com');

    await getAuthPageProps(Promise.resolve({ sso: 'true', email: ' B@Example.com ' }));

    expect(mockedRedirect).toHaveBeenCalledTimes(1);
    expect(mockedRedirect.mock.calls[0]?.[0]).toContain('/users/after-sign-in?');
  });

  it('redirects when the SSO request carries an empty email', async () => {
    signedInAs('b@example.com');

    await getAuthPageProps(Promise.resolve({ sso: 'true', email: '' }));

    expect(mockedRedirect).toHaveBeenCalledWith('/users/after-sign-in?sso=true&email=');
  });

  it('redirects when the SSO request carries no email parameter', async () => {
    signedInAs('b@example.com');

    await getAuthPageProps(Promise.resolve({ sso: 'true' }));

    expect(mockedRedirect).toHaveBeenCalledWith('/users/after-sign-in?sso=true');
  });

  it('redirects a non-SSO prefilled email without comparing it', async () => {
    signedInAs('b@example.com');

    await getAuthPageProps(Promise.resolve({ email: 'a@example.com' }));

    expect(mockedRedirect).toHaveBeenCalledWith('/users/after-sign-in?email=a%40example.com');
  });

  it('does not compare or redirect a signed-out visitor', async () => {
    signedInAs(null);

    const result = await getAuthPageProps(Promise.resolve({ sso: 'true', email: 'a@example.com' }));

    expect(mockedRedirect).not.toHaveBeenCalled();
    expect(result.accountMismatch).toBeUndefined();
  });
});

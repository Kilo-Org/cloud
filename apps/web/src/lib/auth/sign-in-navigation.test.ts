import {
  buildEnterpriseSsoHref,
  buildNormalSignInHref,
  buildSsoAccountSwitchHref,
} from './sign-in-navigation';

describe('buildEnterpriseSsoHref', () => {
  it('preserves callback and approved attribution context', () => {
    expect(
      buildEnterpriseSsoHref({
        callbackPath: '/claw/new',
        source: 'extension',
        im_ref: 'impact-click',
        rsCode: 'referral-code',
        utm_source: 'newsletter',
        utm_medium: 'email',
        utm_campaign: 'launch',
      })
    ).toBe(
      '/users/sign_in?source=extension&im_ref=impact-click&rsCode=referral-code&utm_source=newsletter&utm_medium=email&utm_campaign=launch&callbackPath=%2Fclaw%2Fnew&sso=true'
    );
  });

  it('removes stale auth, invitation, and routing parameters', () => {
    expect(
      buildEnterpriseSsoHref({
        callbackPath: 'https://attacker.invalid',
        error: 'OAuthCallback',
        email: 'user@example.com',
        org: 'org-123',
        signup: 'true',
        sso: 'false',
        other: 'discarded',
      })
    ).toBe('/users/sign_in?sso=true');
  });
});

describe('buildNormalSignInHref', () => {
  it('drops SSO routing and stale auth state while retaining approved context', () => {
    expect(
      buildNormalSignInHref({
        sso: 'true',
        domain: 'example.com',
        signup: 'true',
        error: 'OAuthCallback',
        email: 'user@example.com',
        org: 'org-123',
        callbackPath: '/claw/new',
        source: 'extension',
        im_ref: 'impact-click',
        utm_campaign: 'launch',
        other: 'discarded',
      })
    ).toBe(
      '/users/sign_in?source=extension&im_ref=impact-click&utm_campaign=launch&callbackPath=%2Fclaw%2Fnew'
    );
  });
});

describe('buildSsoAccountSwitchHref', () => {
  it('restores the expected email and preserves a validated device callback', () => {
    expect(
      buildSsoAccountSwitchHref(
        { callbackPath: '/device-auth?code=ABC&app=1', sso: 'true', email: 'a@example.com' },
        'a@example.com'
      )
    ).toBe(
      '/users/sign_in?sso=true&email=a%40example.com&callbackPath=%2Fdevice-auth%3Fcode%3DABC%26app%3D1'
    );
  });

  it('never carries the signed-in address into the URL', () => {
    const href = buildSsoAccountSwitchHref(
      {
        callbackPath: '/device-auth?code=ABC&app=1',
        sso: 'true',
        email: 'signed-in@example.com',
        source: 'extension',
      },
      'a@example.com'
    );

    expect(href).toBe(
      '/users/sign_in?sso=true&email=a%40example.com&source=extension&callbackPath=%2Fdevice-auth%3Fcode%3DABC%26app%3D1'
    );
    expect(href).not.toContain('signed-in');
  });
});

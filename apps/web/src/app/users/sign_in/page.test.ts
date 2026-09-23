import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SignInPage from './page';

jest.mock('@/lib/auth/auth-page-wrapper', () => ({
  getAuthPageProps: jest.fn(async (searchParams: Promise<Record<string, string>>) => {
    const params = await searchParams;
    return {
      params,
      error: undefined,
      accountMismatch:
        params.sso === 'true' && params.email === 'a@example.com'
          ? { expectedEmail: 'a@example.com', signedInEmail: 'b@example.com' }
          : undefined,
    };
  }),
}));

jest.mock('@/components/auth/AuthPageLayout', () => ({
  AuthPageLayout: ({ children }: { children: React.ReactNode }) =>
    React.createElement('main', null, children),
}));

jest.mock('@/components/auth/SignInForm', () => ({
  SignInForm: ({
    title,
    accountMismatch,
  }: {
    title: string;
    accountMismatch?: { expectedEmail: string; signedInEmail: string };
  }) =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement('h1', null, title),
      accountMismatch
        ? React.createElement('span', {
            'data-account-mismatch': `${accountMismatch.signedInEmail},${accountMismatch.expectedEmail}`,
          })
        : null
    ),
}));

describe('SignInPage titles', () => {
  it.each([
    ['normal email-first sign-in', {}, 'Welcome.'],
    ['existing-provider selection', { email: 'user@example.com' }, 'Welcome.'],
    ['unknown-account selection', { email: 'new@example.com' }, 'Welcome.'],
    ['explicit sign-up', { signup: 'true' }, 'Create your account'],
    ['enterprise SSO', { sso: 'true' }, 'Enterprise SSO'],
  ])('uses %s title', async (_flow, searchParams, expectedTitle) => {
    const html = renderToStaticMarkup(
      await SignInPage({ searchParams: Promise.resolve(searchParams) })
    );

    expect(html).toContain(`<h1>${expectedTitle}</h1>`);
  });

  it('forwards an SSO account mismatch to the sign-in form', async () => {
    const html = renderToStaticMarkup(
      await SignInPage({ searchParams: Promise.resolve({ sso: 'true', email: 'a@example.com' }) })
    );

    expect(html).toContain('data-account-mismatch="b@example.com,a@example.com"');
  });

  it('forwards no mismatch for a matching SSO request', async () => {
    const html = renderToStaticMarkup(
      await SignInPage({
        searchParams: Promise.resolve({ sso: 'true', email: 'b@example.com' }),
      })
    );

    expect(html).not.toContain('data-account-mismatch');
  });
});

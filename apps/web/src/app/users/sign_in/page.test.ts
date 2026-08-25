import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SignInPage from './page';

jest.mock('@/lib/auth/auth-page-wrapper', () => ({
  getAuthPageProps: jest.fn(async (searchParams: Promise<Record<string, string>>) => ({
    params: await searchParams,
    error: undefined,
  })),
}));

jest.mock('@/components/auth/AuthPageLayout', () => ({
  AuthPageLayout: ({ children }: { children: React.ReactNode }) =>
    React.createElement('main', null, children),
}));

jest.mock('@/components/auth/SignInForm', () => ({
  SignInForm: ({ title }: { title: string }) => React.createElement('h1', null, title),
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
});

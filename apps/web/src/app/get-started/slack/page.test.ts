import * as React from 'react';

// @swc/jest compiles JSX with the classic runtime, and the page imports no
// React default, so its `React.createElement` calls need React on the global.
Object.assign(globalThis, { React });

jest.mock('next/navigation', () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('./_components/SlackGetStartedFlow', () => ({
  SlackGetStartedFlow: () => null,
}));

jest.mock('@/components/auth/SignInForm', () => ({
  SignInForm: () => null,
}));

jest.mock('@/components/auth/AuthPageLayout', () => ({
  AuthPageLayout: ({ children }: { children: React.ReactNode }) => children,
}));

import { redirect } from 'next/navigation';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { SignInForm } from '@/components/auth/SignInForm';
import { SlackGetStartedFlow } from './_components/SlackGetStartedFlow';
import GetStartedSlackPage from './page';

const mockedRedirect = jest.mocked(redirect);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

function renderPage() {
  return GetStartedSlackPage({ searchParams: Promise.resolve({}) });
}

type TestElementProps = { children?: React.ReactNode; [key: string]: unknown };

function findElement(
  node: React.ReactNode,
  type: unknown
): React.ReactElement<TestElementProps> | undefined {
  if (!React.isValidElement<TestElementProps>(node)) return undefined;
  if (node.type === type) return node;

  let found: React.ReactElement<TestElementProps> | undefined;
  React.Children.forEach(node.props.children, child => {
    found ??= findElement(child, type);
  });
  return found;
}

function signInUser(overrides: Record<string, unknown>) {
  mockedGetUserFromAuth.mockResolvedValue({
    user: {
      id: 'user-1',
      google_user_email: 'ada@kilo.test',
      google_user_name: 'Ada Lovelace',
      blocked_reason: null,
      has_validation_stytch: true,
      ...overrides,
    },
  } as never);
}

describe('GetStartedSlackPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sends a restricted account to the restricted-account page', async () => {
    signInUser({ blocked_reason: 'policy violation' });

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT:/account-blocked');

    expect(mockedRedirect).toHaveBeenCalledWith('/account-blocked');
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith({
      adminOnly: false,
      DANGEROUS_allowBlockedUsers: true,
    });
  });

  test('stops a restricted account before the account-verification redirect', async () => {
    signInUser({ blocked_reason: 'policy violation', has_validation_stytch: null });

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT:/account-blocked');

    expect(mockedRedirect).toHaveBeenCalledTimes(1);
    expect(mockedRedirect).toHaveBeenCalledWith('/account-blocked');
  });

  test('returns the onboarding flow for a normal account', async () => {
    signInUser({});

    const element = await renderPage();

    expect(element.type).toBe(SlackGetStartedFlow);
    expect(mockedRedirect).not.toHaveBeenCalled();
  });

  test('keeps the account-verification redirect for an unverified account', async () => {
    signInUser({ has_validation_stytch: null });

    await expect(renderPage()).rejects.toThrow(
      'NEXT_REDIRECT:/account-verification?callbackPath=/get-started/slack'
    );

    expect(mockedRedirect).toHaveBeenCalledTimes(1);
    expect(mockedRedirect).toHaveBeenCalledWith(
      '/account-verification?callbackPath=/get-started/slack'
    );
  });

  test('keeps the sign-up form for a signed-out visitor', async () => {
    mockedGetUserFromAuth.mockResolvedValue({ user: null } as never);

    const element = await renderPage();
    const signInForm = findElement(element, SignInForm);

    expect(signInForm).toBeDefined();
    expect(signInForm?.props).toMatchObject({
      isSignUp: true,
      title: 'Get Started with Kilo for Slack',
    });
    expect(signInForm?.props.searchParams).toEqual(
      expect.objectContaining({ callbackPath: '/get-started/slack' })
    );
    expect(mockedRedirect).not.toHaveBeenCalled();
  });
});

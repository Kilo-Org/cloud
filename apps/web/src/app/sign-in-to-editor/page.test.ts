import React from 'react';

const mockGetUserForCredentialIssuance = jest.fn();
const mockGenerateApiToken = jest.fn();
const mockRedirect = jest.fn();
const mockGetExtensionUrl = jest.fn();
const mockManualSetupSteps = jest.fn(() => null);
const mockOpenIdeAutomatically = jest.fn(() => null);

(globalThis as typeof globalThis & { React: typeof React }).React = React;

jest.mock('@/lib/user/server', () => ({
  getUserFromSessionForCredentialIssuanceOrRedirect: mockGetUserForCredentialIssuance,
}));
jest.mock('@/lib/tokens', () => ({ generateApiToken: mockGenerateApiToken }));
jest.mock('next/navigation', () => ({ redirect: mockRedirect }));
jest.mock('next/headers', () => ({ cookies: jest.fn() }));
jest.mock('@/components/auth/getExtensionUrl', () => ({ getExtensionUrl: mockGetExtensionUrl }));
jest.mock('@/components/auth/OpenCodeEditor', () => ({ OpenCodeEditor: () => null }));
jest.mock('@/components/auth/DelayedLinks', () => ({ DelayedLinks: () => null }));
jest.mock('@/components/KiloCardLayout', () => ({
  KiloCardLayout: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/auth/ManualSetupSteps', () => ({ ManualSetupSteps: mockManualSetupSteps }));
jest.mock('@/components/auth/OpenIdeAutomatically', () => ({
  OpenIdeAutomatically: mockOpenIdeAutomatically,
}));

function findElementProps(
  element: React.ReactNode,
  component: React.ElementType
): Record<string, unknown> | null {
  if (!React.isValidElement(element)) return null;
  const props = element.props as { children?: React.ReactNode };
  if (element.type === component) return props;

  for (const child of React.Children.toArray(props.children)) {
    const childProps = findElementProps(child, component);
    if (childProps) return childProps;
  }

  return null;
}

describe('RedirectPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetExtensionUrl.mockReturnValue({
      extensionUrl: 'kilo://open',
      ideName: 'VS Code',
      urlScheme: 'kilo',
      logoSrc: '/vscode.svg',
    });
    mockGenerateApiToken.mockReturnValue('minted-token');
  });

  it('does not issue an API token when the session credential guard redirects', async () => {
    mockGetUserForCredentialIssuance.mockRejectedValue(new Error('NEXT_REDIRECT'));
    const { default: RedirectPage } = await import('./page');

    await expect(RedirectPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_REDIRECT'
    );
    expect(mockGetUserForCredentialIssuance).toHaveBeenCalledWith(
      '/users/sign_in?callbackPath=/sign-in-to-editor'
    );
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it('redirects unverified users before issuing an API token', async () => {
    mockGetUserForCredentialIssuance.mockResolvedValue({ has_validation_stytch: null });
    mockRedirect.mockImplementation(() => {
      throw new Error('NEXT_REDIRECT');
    });
    const { default: RedirectPage } = await import('./page');

    await expect(RedirectPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_REDIRECT'
    );
    expect(mockRedirect).toHaveBeenCalledWith('/account-verification');
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it('preserves the web manual setup flow', async () => {
    mockGetExtensionUrl.mockReturnValue({
      extensionUrl: 'https://app.kilo.ai',
      ideName: 'Web',
      urlScheme: 'web',
      logoSrc: undefined,
    });
    mockGetUserForCredentialIssuance.mockResolvedValue({ has_validation_stytch: true });
    const { default: RedirectPage } = await import('./page');

    const page = await RedirectPage({ searchParams: Promise.resolve({}) });

    expect(mockGenerateApiToken).toHaveBeenCalledTimes(1);
    expect(findElementProps(page, mockManualSetupSteps)).toMatchObject({
      kiloToken: 'minted-token',
    });
    expect(findElementProps(page, mockOpenIdeAutomatically)).toBeNull();
  });

  it('preserves editor selection props for native IDEs', async () => {
    mockGetUserForCredentialIssuance.mockResolvedValue({ has_validation_stytch: true });
    const { default: RedirectPage } = await import('./page');

    const page = await RedirectPage({ searchParams: Promise.resolve({}) });

    expect(findElementProps(page, mockOpenIdeAutomatically)).toMatchObject({
      url: 'kilo://open?token=minted-token',
      ideName: 'VS Code',
      logoSrc: '/vscode.svg',
      kiloToken: 'minted-token',
    });
  });
});

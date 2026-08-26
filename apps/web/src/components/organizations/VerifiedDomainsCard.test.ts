import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  canViewVerifiedDomainsCard,
  closeVerificationPortal,
  confirmVerifiedDomainRemoval,
  openVerificationPortal,
  reserveVerificationPortal,
  showVerificationPortal,
  VerifiedDomainsCard,
  VerifiedDomainsCardView,
} from './VerifiedDomainsCard';

type ViewProps = React.ComponentProps<typeof VerifiedDomainsCardView>;

const pendingClaim: ViewProps['claims'][number] = {
  id: '2a4dc303-26c6-4cc7-a281-042dd69cae80',
  domain: 'pending.example.com',
  status: 'pending',
  verifiedAt: null,
  createdAt: '2026-08-21T12:00:00.000Z',
  updatedAt: '2026-08-21T12:00:00.000Z',
};

const verifiedClaim: ViewProps['claims'][number] = {
  ...pendingClaim,
  id: '75e00323-b649-44a9-99c7-4f304106df5b',
  domain: 'verified.example.com',
  status: 'verified',
  verifiedAt: '2026-08-21T12:05:00.000Z',
};

function renderView(overrides: Partial<ViewProps> = {}): string {
  const props: ViewProps = {
    claims: [],
    domain: '',
    isCreating: false,
    isLoading: false,
    isMutating: false,
    isRetrying: false,
    onCheckStatus: () => undefined,
    onClaim: () => undefined,
    onDomainChange: () => undefined,
    onRemove: () => undefined,
    onRetryLoad: () => undefined,
    onVerify: () => undefined,
    confirm: async () => false,
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(VerifiedDomainsCardView, props));
}

describe('VerifiedDomainsCard', () => {
  test('renders the empty state and automatic-membership boundaries', () => {
    const html = renderView();

    expect(html).toContain('No verified domains yet.');
    expect(html).toContain('ordinary members');
    expect(html).toContain('personal account and other organizations');
    expect(html).toContain('Claim and verify');
  });

  test('renders pending and verified claims with explicit status actions', () => {
    const html = renderView({ claims: [pendingClaim, verifiedClaim] });

    expect(html).toContain('pending.example.com');
    expect(html).toContain('Pending');
    expect(html).toContain('Open verification');
    expect(html).toContain('verified.example.com');
    expect(html).toContain('Verified');
    expect(html.match(/Check status/g)).toHaveLength(2);
    expect(html.match(/Open verification/g)).toHaveLength(1);
  });

  test('gates the card to owner/admin authority and excludes billing managers', () => {
    expect(canViewVerifiedDomainsCard('owner')).toBe(true);
    expect(canViewVerifiedDomainsCard('admin')).toBe(true);
    expect(canViewVerifiedDomainsCard('member')).toBe(false);
    expect(canViewVerifiedDomainsCard('billing_manager')).toBe(false);

    const billingHtml = renderToStaticMarkup(
      React.createElement(VerifiedDomainsCard, {
        organizationId: '5f30ac41-c23f-4581-a12d-2429172fa595',
        role: 'billing_manager',
      })
    );
    expect(billingHtml).toBe('');
  });

  test('shows loading and actionable provider/load errors without a false empty state', () => {
    expect(renderView({ isLoading: true })).toContain('Loading verified domains...');

    const errorHtml = renderView({
      errorMessage: 'Domain verification provider request failed',
    });
    expect(errorHtml).toContain('Verified domains unavailable');
    expect(errorHtml).toContain('Domain verification provider request failed');
    expect(errorHtml).toContain('Try again');
    expect(errorHtml).not.toContain('No verified domains yet.');
  });

  test('disables claim, refresh, verification, and removal controls during creation', () => {
    const html = renderView({
      claims: [pendingClaim],
      domain: 'new.example.com',
      isCreating: true,
      isMutating: true,
    });

    expect(html).toContain('Opening verification...');
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(5);
  });

  test('does not label unrelated mutations as opening verification', () => {
    const html = renderView({
      claims: [verifiedClaim],
      domain: 'new.example.com',
      isMutating: true,
    });

    expect(html).toContain('Claim and verify');
    expect(html).not.toContain('Opening verification...');
  });

  test('shows retry progress and disables repeated retries', () => {
    const html = renderView({
      errorMessage: 'Domain verification provider request failed',
      isRetrying: true,
    });

    expect(html).toContain('Trying again...');
    expect(html).toContain('disabled=""');
  });

  test('opens the returned verification portal URL with external-link protections', () => {
    const openExternal = jest.fn<
      Window | null,
      [string | URL | undefined, string | undefined, string | undefined]
    >(() => null);

    openVerificationPortal('https://setup.workos.com/domain/verify', openExternal);

    expect(openExternal).toHaveBeenCalledWith(
      'https://setup.workos.com/domain/verify',
      '_blank',
      'noopener,noreferrer'
    );
  });

  test('reserves a provider tab during the user action and detaches its opener', () => {
    const portal = Object.assign({} as Window, { opener: {} });
    const openExternal = jest.fn<Window | null, Parameters<typeof window.open>>(() => portal);

    expect(reserveVerificationPortal(openExternal)).toBe(portal);
    expect(openExternal).toHaveBeenCalledWith('', '_blank');
    expect(portal.opener).toBeNull();
  });

  test('does not wedge verification when popup reservation throws', () => {
    const openExternal = jest.fn<Window | null, Parameters<typeof window.open>>(() => {
      throw new Error('Popup access denied');
    });

    expect(reserveVerificationPortal(openExternal)).toBeNull();
  });

  test('closes a reserved tab when detaching its opener fails', () => {
    const close = jest.fn();
    const portal = {
      closed: false,
      close,
      set opener(_value: Window | null) {
        throw new Error('Popup access denied');
      },
    } as unknown as Window;

    expect(reserveVerificationPortal(() => portal)).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('falls back to a new tab when the reserved provider tab was closed', () => {
    const portal = { closed: true } as Window;
    const openExternal = jest.fn<Window | null, Parameters<typeof window.open>>(() => null);

    showVerificationPortal(portal, 'https://setup.workos.com/domain/verify', openExternal);

    expect(openExternal).toHaveBeenCalledWith(
      'https://setup.workos.com/domain/verify',
      '_blank',
      'noopener,noreferrer'
    );
  });

  test('falls back and closes the reserved tab when navigation fails', () => {
    const close = jest.fn();
    const location = {
      set href(_value: string) {
        throw new Error('closed');
      },
    };
    const portal = { closed: false, close, location } as unknown as Window;
    const openExternal = jest.fn<Window | null, Parameters<typeof window.open>>(() => null);

    showVerificationPortal(portal, 'https://setup.workos.com/domain/verify', openExternal);

    expect(close).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  test('closes an open reserved provider tab during cleanup', () => {
    const close = jest.fn();
    const portal = { closed: false, close } as unknown as Window;

    closeVerificationPortal(portal);

    expect(close).toHaveBeenCalledTimes(1);
  });

  test('does not let popup inspection or closure break cleanup', () => {
    const portal = {
      get closed() {
        throw new Error('Popup access denied');
      },
    } as unknown as Window;

    expect(() => closeVerificationPortal(portal)).not.toThrow();
  });

  test('does not let a blocked fallback break mutation success handling', () => {
    const openExternal = jest.fn<Window | null, Parameters<typeof window.open>>(() => {
      throw new Error('Popup access denied');
    });

    expect(() =>
      showVerificationPortal(null, 'https://setup.workos.com/domain/verify', openExternal)
    ).not.toThrow();
  });

  test('removal confirmation explains future joins and preserves current members', async () => {
    const confirm = jest.fn(async () => true);
    const onRemove = jest.fn();

    await confirmVerifiedDomainRemoval(confirm, verifiedClaim, onRemove);

    expect(confirm).toHaveBeenCalledWith({
      title: 'Remove verified.example.com?',
      description:
        'This stops future automatic joins for this domain. Current members remain in the organization.',
      confirmLabel: 'Remove domain',
      destructive: true,
    });
    expect(onRemove).toHaveBeenCalledWith(verifiedClaim.id);
  });

  test('removal confirmation describes cancelling a pending claim', async () => {
    const confirm = jest.fn(async () => true);

    await confirmVerifiedDomainRemoval(confirm, pendingClaim, jest.fn());

    expect(confirm).toHaveBeenCalledWith({
      title: 'Remove pending.example.com?',
      description: 'This cancels domain verification. The pending claim will be removed.',
      confirmLabel: 'Remove domain',
      destructive: true,
    });
  });

  test('keeps the claim when removal confirmation is cancelled', async () => {
    const onRemove = jest.fn();

    await confirmVerifiedDomainRemoval(async () => false, pendingClaim, onRemove);

    expect(onRemove).not.toHaveBeenCalled();
  });
});

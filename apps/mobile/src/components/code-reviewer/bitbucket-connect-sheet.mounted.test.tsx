// The sheet's two entry answers: a workspace the token form can connect, and an
// organization already connected through Bitbucket OAuth. `connect` refuses a
// second integration, so the second case names the page that owns the OAuth
// flow instead of a form whose submit the server would reject.

import { createElement, type ElementType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { openExternalUrl } from '@/lib/external-link';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { BitbucketConnectSheet } from './bitbucket-connect-sheet';

type IntegrationMethod = 'oauth' | 'workspace_access_token';

const state = vi.hoisted(() => ({
  role: 'owner' as string | undefined,
  readiness: {
    connected: false,
    ready: false,
    integrationId: null as string | null,
    workspace: null as unknown,
    missingRequiredScopes: ['account'] as string[],
    repositoryCache: { status: 'uninitialized', repositories: [], syncedAt: null as string | null },
  },
  status: {
    data: undefined as { method: IntegrationMethod; integrationId: string | null } | undefined,
    isPending: false,
  },
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-haptics', () => ({
  NotificationFeedbackType: { Success: 'success' },
  notificationAsync: vi.fn(),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.example.test' }));
vi.mock('@/lib/haptics', () => ({ notificationHaptic: vi.fn() }));
vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: { success: vi.fn() } }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => ({
    role: state.role,
    org: { organizationId: 'org-1', organizationName: 'Acme' },
    isResolving: false,
    isError: false,
  }),
}));
vi.mock('@/lib/hooks/use-bitbucket', () => ({
  useBitbucketReadiness: () => ({
    data: state.readiness,
    isPending: false,
    isError: false,
    isFetching: false,
    error: undefined,
    refetch: vi.fn(),
  }),
  useBitbucketIntegrationStatus: () => ({
    data: state.status.data,
    isPending: state.status.isPending,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/components/tab-screen', () => ({ SheetScrollView: 'SheetScrollView' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/organization/permission-denied', () => ({
  PermissionDenied: 'PermissionDenied',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/code-reviewer/bitbucket-connect-form', () => ({
  BitbucketConnectForm: 'BitbucketConnectForm',
}));

const BUTTON = 'Button' as ElementType;
const FORM = 'BitbucketConnectForm' as ElementType;
const PERMISSION_DENIED = 'PermissionDenied' as ElementType;

async function mount(): Promise<ReactTestRenderer['root']> {
  const view = await renderWithProviders(createElement(BitbucketConnectSheet, { scope: 'org-1' }));
  return view.renderer.root;
}

/** The one control the sheet offers for a connection it cannot touch here. */
function manageButtons(root: ReactTestRenderer['root']) {
  return root.findAll(
    node =>
      Object.is(node.type, BUTTON) &&
      node
        .findAll(child => Object.is(child.type, 'Text'))
        .some(child => Object.values(child.props).includes(i18n.t('common.manageOnWeb')))
  );
}

function manageButton(root: ReactTestRenderer['root']) {
  const [button] = manageButtons(root);
  if (!button) {
    throw new Error('missing manage button');
  }
  return button;
}

beforeEach(() => {
  state.role = 'owner';
  state.readiness.integrationId = null;
  state.status.data = undefined;
  state.status.isPending = false;
  vi.mocked(openExternalUrl).mockReset();
});

describe('BitbucketConnectSheet', () => {
  it('sends a workspace connected through Bitbucket OAuth to the page that owns it', async () => {
    state.status.data = { method: 'oauth', integrationId: 'bitbucket-4' };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);

    await act(async () => {
      (manageButton(root).props.onPress as () => void)();
      await Promise.resolve();
    });

    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(
      'https://app.example.test/organizations/org-1/integrations/bitbucket',
      { label: i18n.t('common.manageOnWeb') }
    );
  });

  it('keeps the token form for a workspace with no integration', async () => {
    state.status.data = { method: 'workspace_access_token', integrationId: null };
    const root = await mount();

    expect(manageButtons(root)).toHaveLength(0);
    const [form] = root.findAll(node => Object.is(node.type, FORM));
    expect(form?.props.integrationId).toBeNull();
  });

  it('replaces the token of the integration the readiness read names', async () => {
    state.readiness.integrationId = 'bitbucket-2';
    state.status.data = { method: 'workspace_access_token', integrationId: 'bitbucket-2' };
    const root = await mount();

    expect(manageButtons(root)).toHaveLength(0);
    expect(root.findAll(node => Object.is(node.type, FORM))[0]?.props.integrationId).toBe(
      'bitbucket-2'
    );
  });

  it('asks for an owner when the viewer cannot change an existing connection', async () => {
    state.role = 'member';
    state.status.data = { method: 'oauth', integrationId: 'bitbucket-4' };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    const [denied] = root.findAll(node => Object.is(node.type, PERMISSION_DENIED));
    expect(denied?.props.description).toBe(i18n.t('integrations.managedByOwner'));
  });
});

// The sheet's two entry answers: a workspace the token form can connect, and an
// organization already connected through Bitbucket OAuth. `connect` refuses a
// second integration, so the second case names that connection and says where
// it is managed, without offering a form the server would reject.

import { createElement, type ElementType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type ReactTestRenderer } from '@/test/renderer';
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
    isError: false,
    error: undefined as unknown,
  },
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-haptics', () => ({
  NotificationFeedbackType: { Success: 'success' },
  notificationAsync: vi.fn(),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/haptics', () => ({ notificationHaptic: vi.fn() }));
vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: { success: vi.fn() } }));
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
    isError: state.status.isError,
    error: state.status.error,
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
const QUERY_ERROR = 'QueryError' as ElementType;
const SKELETON = 'Skeleton' as ElementType;
/** The sentence that names where a connection the app cannot change is managed. */
const MANAGED_ON_WEB = i18n.t('codeReviewer.bitbucketConnect.managedOnWeb', {
  organization: 'Acme',
});

async function mount(): Promise<ReactTestRenderer['root']> {
  const view = await renderWithProviders(createElement(BitbucketConnectSheet, { scope: 'org-1' }));
  return view.renderer.root;
}

/** Whether the sheet renders this exact copy. */
function rendersText(root: ReactTestRenderer['root'], value: string): boolean {
  return root
    .findAll(node => Object.is(node.type, 'Text'))
    .some(node => node.children.includes(value));
}

beforeEach(() => {
  state.role = 'owner';
  state.readiness.integrationId = null;
  state.status.data = undefined;
  state.status.isPending = false;
  state.status.isError = false;
  state.status.error = undefined;
});

describe('BitbucketConnectSheet', () => {
  it('names an existing Bitbucket OAuth connection and says where it is managed', async () => {
    state.status.data = { method: 'oauth', integrationId: 'bitbucket-4' };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    expect(rendersText(root, MANAGED_ON_WEB)).toBe(true);
    // The note names the organization whose connection the reader has to change
    // elsewhere, because a person in several organizations cannot tell which one
    // the sheet is about.
    expect(MANAGED_ON_WEB).toContain('Acme');
    // The connection page is not a place this sheet sends the reader: the note
    // is text, and the sheet offers nothing to press.
    expect(root.findAll(node => Object.is(node.type, BUTTON))).toHaveLength(0);
  });

  it('keeps the token form for a workspace with no integration', async () => {
    state.status.data = { method: 'workspace_access_token', integrationId: null };
    const root = await mount();

    expect(rendersText(root, MANAGED_ON_WEB)).toBe(false);
    const [form] = root.findAll(node => Object.is(node.type, FORM));
    expect(form?.props.integrationId).toBeNull();
    expect(form?.props.organizationName).toBe('Acme');
  });

  it('replaces the token of the integration the readiness read names', async () => {
    state.readiness.integrationId = 'bitbucket-2';
    // The status read names no token integration, so only the readiness id can
    // reach the form.
    state.status.data = { method: 'workspace_access_token', integrationId: null };
    const root = await mount();

    expect(rendersText(root, MANAGED_ON_WEB)).toBe(false);
    expect(root.findAll(node => Object.is(node.type, FORM))[0]?.props.integrationId).toBe(
      'bitbucket-2'
    );
  });

  it('waits for the status read before offering the token form', async () => {
    state.status.isPending = true;
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    expect(root.findAll(node => Object.is(node.type, SKELETON)).length).toBeGreaterThan(0);
  });

  it('retries instead of offering the token form when the status read fails', async () => {
    state.status.isError = true;
    state.status.error = new Error('request failed');
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    expect(root.findAll(node => Object.is(node.type, QUERY_ERROR))).toHaveLength(1);
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

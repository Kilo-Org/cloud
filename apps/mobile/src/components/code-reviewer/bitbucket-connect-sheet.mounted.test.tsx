// The sheet's two entry answers: a workspace the token form can connect, and an
// organization already connected through Bitbucket OAuth. `connect` refuses a
// second integration, so the second case names that connection and says where
// it is managed, without offering a form the server would reject.

import { createElement, type ElementType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { BitbucketConnectSheet } from './bitbucket-connect-sheet';

type IntegrationMethod = 'oauth' | 'workspace_access_token';

type LeaveOptions = {
  data: { action: { type: string } };
  repeat: () => void;
};

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
};

const routerMock = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));

// react-navigation only calls the removal handler while the route prevents the
// removal, so the stand-in records both values: `prevent` is what says whether
// the guard is armed, and `handler` is the leave the navigator would run.
const preventRemoveMock = vi.hoisted(() => ({
  prevent: false,
  handler: undefined as ((options: LeaveOptions) => void) | undefined,
}));

// The confirm node is the native dialog, covered by its own suite; here it is a
// request log so the assertions stay on the gate's decisions.
const confirmMock = vi.hoisted(() => ({ requests: [] as ConfirmRequest[] }));

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

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StatusBar: { currentHeight: 0 },
  View: 'View',
}));
// The surface's status-bar clearance reads the window insets, and this node
// project cannot load the library's Flow entry: stub its one native dependency,
// which is what every mounted suite here does. A zero top inset is the iOS
// formSheet case, so the wrapper adds no padding.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-haptics', () => ({
  NotificationFeedbackType: { Success: 'success' },
  notificationAsync: vi.fn(),
}));
vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
  usePreventRemove: (prevent: boolean, handler: (options: LeaveOptions) => void) => {
    preventRemoveMock.prevent = prevent;
    preventRemoveMock.handler = handler;
  },
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: ConfirmRequest) => {
      confirmMock.requests.push(request);
    },
    dialog: 'ConfirmDialog',
  }),
}));
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
vi.mock('@/components/code-reviewer/bitbucket-connect-form', async () => {
  // `vi.mock` hoists above the module's imports, so the factory cannot close
  // over the top-level `createElement` binding.
  const { createElement: h } = await import('react');
  // The real form's surface that the sheet drives: the draft report the leave
  // guard listens to and the dismissal a landed token requests.
  function BitbucketConnectForm(props: {
    integrationId: string | null;
    onConnected: () => void;
    onDirtyChange?: (dirty: boolean) => void;
  }) {
    return h('BitbucketConnectForm', props);
  }
  return { BitbucketConnectForm };
});

const BUTTON = 'Button' as ElementType;
const FORM = 'BitbucketConnectForm' as ElementType;
const PERMISSION_DENIED = 'PermissionDenied' as ElementType;
const QUERY_ERROR = 'QueryError' as ElementType;
const SKELETON = 'Skeleton' as ElementType;
/** The sentence that names where a connection the app cannot change is managed. */
const MANAGED_ON_WEB = i18n.t('codeReviewer.bitbucketConnect.managedOnWeb');

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

type FormProps = Readonly<{
  integrationId: string | null;
  onConnected: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}>;

/** The props the sheet handed the connect form, which is where its draft and dismissal live. */
function formProps(root: ReactTestRenderer['root']): FormProps {
  const [form] = root.findAll(node => Object.is(node.type, FORM));
  if (!form) {
    throw new Error('missing connect form');
  }
  return form.props as FormProps;
}

/** A Back the navigator would run, and whether the guard let it through. */
async function leave(type = 'GO_BACK'): Promise<{ repeat: () => void }> {
  const repeat = vi.fn<() => void>();
  await act(async () => {
    preventRemoveMock.handler?.({ data: { action: { type } }, repeat });
    await Promise.resolve();
  });
  return { repeat };
}

/** Mount the token form's sheet, which is the state the guard speaks for. */
function mountForm(): Promise<ReactTestRenderer['root']> {
  state.status.data = { method: 'workspace_access_token', integrationId: null };
  return mount();
}

async function reportDirty(root: ReactTestRenderer['root'], dirty: boolean): Promise<void> {
  await act(async () => {
    formProps(root).onDirtyChange?.(dirty);
    await Promise.resolve();
  });
}

beforeEach(() => {
  state.role = 'owner';
  state.readiness.integrationId = null;
  state.status.data = undefined;
  state.status.isPending = false;
  state.status.isError = false;
  state.status.error = undefined;
  routerMock.back.mockClear();
  preventRemoveMock.prevent = false;
  preventRemoveMock.handler = undefined;
  confirmMock.requests.length = 0;
});

describe('BitbucketConnectSheet', () => {
  it('names an existing Bitbucket OAuth connection and says where it is managed', async () => {
    state.status.data = { method: 'oauth', integrationId: 'bitbucket-4' };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    expect(rendersText(root, MANAGED_ON_WEB)).toBe(true);
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

  it('asks before a typed token is dropped, and only discards on the confirm', async () => {
    const root = await mountForm();
    await reportDirty(root, true);

    expect(preventRemoveMock.prevent).toBe(true);
    const { repeat } = await leave();

    // The Back is held while the sheet asks, so nothing leaves yet.
    expect(repeat).not.toHaveBeenCalled();
    const [request] = confirmMock.requests;
    expect(request?.title).toBe(i18n.t('common.discardChangesTitle'));
    expect(request?.message).toBe(i18n.t('common.discardChangesMessage'));
    expect(request?.confirmLabel).toBe(i18n.t('common.discard'));
    expect(request?.cancelLabel).toBe(i18n.t('common.keepEditing'));

    // Discard replays the intercepted Back rather than replacing the route.
    await act(async () => {
      request?.onConfirm();
      await Promise.resolve();
    });

    expect(repeat).toHaveBeenCalledTimes(1);
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  it('leaves a clean sheet without asking', async () => {
    await mountForm();

    expect(preventRemoveMock.prevent).toBe(false);
    const { repeat } = await leave();

    expect(repeat).toHaveBeenCalledTimes(1);
    expect(confirmMock.requests).toHaveLength(0);
  });

  it('leaves without asking once a connect accepted the token', async () => {
    const root = await mountForm();
    await reportDirty(root, true);

    await act(async () => {
      formProps(root).onConnected();
      await Promise.resolve();
    });
    // The dismissal waits one task for the guard to disarm before popping.
    await act(async () => {
      const tick = Promise.withResolvers<undefined>();
      setTimeout(tick.resolve, 0);
      await tick.promise;
    });

    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(preventRemoveMock.prevent).toBe(false);

    // The guard is disarmed for the leave the connect owns, so a Back the
    // navigator runs next is not held for a confirmation.
    const { repeat } = await leave();

    expect(repeat).toHaveBeenCalledTimes(1);
    expect(confirmMock.requests).toHaveLength(0);
  });
});

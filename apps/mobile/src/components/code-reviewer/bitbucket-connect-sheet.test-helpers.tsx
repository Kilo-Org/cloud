// The sheet's mounted doubles: the navigator pair the leave guard talks to, the
// confirm request log, and the two reads the sheet branches on. Both sheet
// suites import this, so the mock set lives in one place; `vi.mock` runs while
// the importing suite's module graph loads, which is before any case runs.

import { createElement, type ElementType } from 'react';
import { vi } from 'vitest';

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

/**
 * The platform and the status read are mutable between renders here, because
 * the cases mount one thing and then change the other: the sheet's heading
 * differs by platform, and a background read can replace the form with an error
 * or a note while a draft is typed.
 */
const platformMock = vi.hoisted(() => ({ OS: 'ios' }));
const statusStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    notify(): void {
      version += 1;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot(): number {
      return version;
    },
  };
});

vi.mock('react-native', () => ({
  Platform: platformMock,
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
// The confirm node is the native dialog, covered by its own suite; here it is a
// host element so a case can find it, plus a request log so the assertions stay
// on the gate's decisions. `vi.mock` hoists above the imports, so React comes
// from a dynamic import.
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  return {
    useConfirmDialog: () => ({
      confirm: (request: ConfirmRequest) => {
        confirmMock.requests.push(request);
      },
      dialog: h('ConfirmDialog'),
    }),
  };
});
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
vi.mock('@/lib/hooks/use-bitbucket', async () => {
  // Subscribing is what lets a case change the status read after mount, the way
  // a background answer does.
  const { useSyncExternalStore } = await import('react');
  return {
    useBitbucketReadiness: () => ({
      data: state.readiness,
      isPending: false,
      isError: false,
      isFetching: false,
      error: undefined,
      refetch: vi.fn(),
    }),
    useBitbucketIntegrationStatus: () => {
      useSyncExternalStore(
        listener => statusStore.subscribe(listener),
        () => statusStore.snapshot()
      );
      return {
        data: state.status.data,
        isPending: state.status.isPending,
        isError: state.status.isError,
        error: state.status.error,
        isFetching: false,
        refetch: vi.fn(),
      };
    },
  };
});
vi.mock('@/components/tab-screen', () => ({ SheetScrollView: 'SheetScrollView' }));
// The header is the app's shared surface: its own suite covers the close
// control, and the sheet's suite asserts the sheet wires it.
vi.mock('@/components/screen-header', async () => {
  const { createElement: h } = await import('react');
  return { ScreenHeader: (props: { title: string }) => h('ScreenHeader', props) };
});
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

export const BOUNDARY = 'OrganizationBoundary' as ElementType;
export const BUTTON = 'Button' as ElementType;
export const DIALOG = 'ConfirmDialog' as ElementType;
export const FORM = 'BitbucketConnectForm' as ElementType;
export const HEADER = 'ScreenHeader' as ElementType;
export const PERMISSION_DENIED = 'PermissionDenied' as ElementType;
export const QUERY_ERROR = 'QueryError' as ElementType;
export const SKELETON = 'Skeleton' as ElementType;

export async function mount(): Promise<ReactTestRenderer['root']> {
  const view = await renderWithProviders(createElement(BitbucketConnectSheet, { scope: 'org-1' }));
  return view.renderer.root;
}

/** The props the sheet handed the connect form, which is where its draft and dismissal live. */
export function formProps(root: ReactTestRenderer['root']): {
  integrationId: string | null;
  onConnected: () => void;
  onDirtyChange?: (dirty: boolean) => void;
} {
  const [form] = root.findAll(node => Object.is(node.type, FORM));
  if (!form) {
    throw new Error('missing connect form');
  }
  return form.props as {
    integrationId: string | null;
    onConnected: () => void;
    onDirtyChange?: (dirty: boolean) => void;
  };
}

/** A Back the navigator would run, and whether the guard let it through. */
export async function leave(type = 'GO_BACK'): Promise<{ repeat: () => void }> {
  const repeat = vi.fn<() => void>();
  await act(async () => {
    preventRemoveMock.handler?.({ data: { action: { type } }, repeat });
    await Promise.resolve();
  });
  return { repeat };
}

/** Mount the sheet with no scope, the state that renders the boundary. */
export function mountWithoutScope(): Promise<ReactTestRenderer['root']> {
  return renderWithProviders(createElement(BitbucketConnectSheet, { scope: undefined })).then(
    view => view.renderer.root
  );
}

/** Mount the token form's sheet, which is the state the guard speaks for. */
export function mountForm(): Promise<ReactTestRenderer['root']> {
  state.status.data = { method: 'workspace_access_token', integrationId: null };
  return mount();
}

export async function reportDirty(root: ReactTestRenderer['root'], dirty: boolean): Promise<void> {
  await act(async () => {
    formProps(root).onDirtyChange?.(dirty);
    await Promise.resolve();
  });
}

/** The state every case starts from, plus the mock logs a case reads. */
export function resetSheetMocks(): void {
  state.role = 'owner';
  platformMock.OS = 'ios';
  state.readiness.integrationId = null;
  state.status.data = undefined;
  state.status.isPending = false;
  state.status.isError = false;
  state.status.error = undefined;
  routerMock.back.mockClear();
  preventRemoveMock.prevent = false;
  preventRemoveMock.handler = undefined;
  confirmMock.requests.length = 0;
}

export { confirmMock, platformMock, preventRemoveMock, routerMock, state, statusStore };

/* eslint-disable max-lines -- one shared harness mocks every native module and the tRPC surface the passkey suites reach. */
import { createElement, type ElementType, type ReactNode, useSyncExternalStore } from 'react';
import { vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';
import { PasskeysScreen } from './passkeys-screen';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

/** One `user.getPasskeys` row; a test overrides only the fields it cares about. */
type PasskeyFixture = {
  id: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
  device_type: string;
  backed_up: boolean;
};

function passkey(overrides: Partial<PasskeyFixture> & { id: string }): PasskeyFixture {
  return {
    name: 'MacBook',
    created_at: '2026-01-02T03:04:05Z',
    last_used_at: null,
    device_type: 'singleDevice',
    backed_up: false,
    ...overrides,
  };
}

export const MACBOOK = passkey({ id: 'pk-1', name: 'MacBook' });
export const UNNAMED = passkey({ id: 'pk-2', name: null, created_at: '2026-02-03T04:05:06Z' });
/** A passkey the server recorded a use for, so its row carries the last-used line. */
export const USED = passkey({
  id: 'pk-3',
  name: 'Work laptop',
  created_at: '2026-03-01T00:00:00Z',
  last_used_at: '2026-03-04T05:06:07Z',
});

/** What mounting the screen returns: the renderer and its query client. */
export type PasskeysView = RenderWithProvidersResult;

// ── Hoisted mocks ──────────────────────────────────────────────────────────
// The harness lives here so the scenario file stays under the repository's
// max-lines rule, the split app-unlock-screen.test-helpers.tsx uses.

const list = vi.hoisted(() => ({
  key: ['user', 'getPasskeys'] as string[],
  queryFn: vi.fn(),
  deleteFn: vi.fn(),
  renameFn: vi.fn(),
  register: vi.fn(),
  supported: vi.fn(() => true),
  requestCode: vi.fn(),
  authorizeCode: vi.fn(),
  authorizeTicket: vi.fn(),
  mintTicket: vi.fn(),
  startSso: vi.fn(),
  collectSso: vi.fn(),
}));
/** The account the screen is signed in as; a test may switch it mid-flight. */
type Identity = { userId: string | undefined; email: string | undefined };
const identity = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let value: Identity = { userId: 'user-1', email: 'person@example.com' };
  return {
    get: () => value,
    set: (next: Identity) => {
      value = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});
/** The OS browser the SSO handoff opens; a test makes it refuse or resolve. */
const browser = vi.hoisted(() => ({ open: vi.fn(), dismiss: vi.fn() }));
const store = vi.hoisted(() => ({ rows: [] as unknown[] }));
/** The window the screen lays out in; a test sets a landscape size to read the
 *  short-window presentation and restores it afterwards. */
const windowSize = vi.hoisted(() => ({ width: 411, height: 914 }));
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const confirmSpy = vi.hoisted(() => vi.fn());
// `vi.hoisted` results cannot be exported at their declaration (vitest hoists
// them above the export), so they are exported after the declaration instead.
export { browser, confirmSpy, list, store, toastError, toastSuccess, windowSize };

/**
 * The confirmation the stubbed `useConfirmDialog` captured; mirrors the
 * `ConfirmDialogRequest` the screen passes.
 */
export type CapturedConfirm = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  presentation?: 'screen' | 'sheet';
  onConfirm: () => void;
};

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getPasskeys: {
        queryKey: () => list.key,
        queryOptions: () => ({ queryKey: list.key, queryFn: list.queryFn }),
      },
      deletePasskey: {
        mutationOptions: (opts: object) => ({ ...opts, mutationFn: list.deleteFn }),
      },
      renamePasskey: {
        mutationOptions: (opts: object) => ({ ...opts, mutationFn: list.renameFn }),
      },
    },
  }),
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ token: 'test-token' }) }));
// The screen reads the account on every render, so a test can sign it in as
// someone else mid-flight and watch a late answer lose its owner.
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => useSyncExternalStore(identity.subscribe, identity.get, identity.get),
}));
vi.mock('@/lib/auth/passkey-client', () => ({
  registerPasskey: list.register,
  passkeysSupported: list.supported,
  mintPasskeyTicket: list.mintTicket,
}));
vi.mock('@/lib/auth/passkey-management', () => ({
  requestManagementCode: list.requestCode,
  authorizePasskeyManagementWithCode: list.authorizeCode,
  authorizePasskeyManagementWithTicket: list.authorizeTicket,
  startPasskeyManagementSso: list.startSso,
  collectPasskeyManagementSso: list.collectSso,
}));
vi.mock('@/lib/auth/auth-browser', () => ({
  openAuthBrowser: browser.open,
  dismissAuthBrowser: browser.dismiss,
  // The real classifier reads the URL's host and the platform; these suites
  // only need one stable kind to pair with the close.
  resolveAuthBrowserKind: () => 'auth-session',
}));
vi.mock('sonner-native', () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Modal: 'Modal',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  useWindowDimensions: () => windowSize,
  View: 'View',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    destructive: '#ff0000',
    foreground: '#000000',
    mutedForeground: '#666666',
    secondaryForeground: '#333333',
  }),
}));
vi.mock('@/lib/format', () => ({
  formatDate: () => 'Jan 1, 2026',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 0 }));
vi.mock('@/components/empty-state', () => ({
  // Renders the action so a test can reach the CTA that lives inside it.
  EmptyState: (props: { action?: ReactNode }) => createElement('EmptyState', props, props.action),
  // The action is a control: the suites read its label from the node and press
  // it through the same `Pressable` shape a row control has.
  StateAction: (props: { label?: string; onPress?: () => void }) =>
    createElement(
      'Pressable',
      { accessibilityLabel: props.label, onPress: props.onPress },
      createElement('Text', null, props.label)
    ),
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
// The removal confirmation is the app's in-app dialog. The screen's own
// behaviour is the subject here, so the hook is stubbed: `confirm` captures the
// request and the node it returns is irrelevant to these suites.
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmSpy, dialog: 'ConfirmDialog' }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
// The layout primitives the screen composes. Each mock renders what the
// assertions read: the row's icon, its title and secondary line, the control
// the row carries, and one bar per skeleton line.
vi.mock('@/components/ui/section', () => ({
  Section: (props: { children?: ReactNode }) => props.children,
}));
vi.mock('@/components/ui/row-group', () => ({
  RowGroup: (props: { children?: ReactNode }) => props.children,
}));
vi.mock('@/components/ui/card', () => ({ Card: 'Card' }));
vi.mock('@/components/ui/screen-footer', () => ({
  ScreenFooter: (props: { children?: ReactNode }) =>
    createElement('ScreenFooter', null, props.children),
}));
vi.mock('@/components/ui/row-skeleton', () => ({
  RowSkeleton: (props: { tile?: boolean; subtitle?: boolean }) =>
    createElement(
      'View',
      null,
      props.tile === true ? createElement('Skeleton') : null,
      createElement('Skeleton'),
      props.subtitle === true ? createElement('Skeleton') : null
    ),
}));
vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: (props: {
    icon?: ElementType;
    title: string;
    subtitle?: string;
    trailing?: ReactNode;
  }) =>
    createElement(
      'View',
      null,
      props.icon === undefined ? null : createElement(props.icon),
      createElement('Text', { numberOfLines: 1 }, props.title),
      props.subtitle === undefined ? null : createElement('Text', null, props.subtitle),
      props.trailing ?? null
    ),
}));
// The passkey row keeps each fact on its own line, so it composes the frame
// directly: the title, the added date and the optional last-used line.
vi.mock('@/components/ui/row-frame', () => ({
  RowFrame: (props: {
    icon?: ElementType;
    title?: string;
    subtitle?: { text: string };
    secondSubtitle?: { text: string };
    trailing?: { kind: 'node'; node: ReactNode };
  }) =>
    createElement(
      'View',
      null,
      props.icon === undefined ? null : createElement(props.icon),
      props.title === undefined ? null : createElement('Text', { numberOfLines: 1 }, props.title),
      props.subtitle === undefined ? null : createElement('Text', null, props.subtitle.text),
      props.secondSubtitle === undefined
        ? null
        : createElement('Text', null, props.secondSubtitle.text),
      props.trailing === undefined ? null : props.trailing.node
    ),
}));
vi.mock('@/components/ui/icon-button', () => ({
  IconButton: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) =>
    createElement(
      'Pressable',
      { ...props, className: 'h-[48px] w-[48px] items-center justify-center' },
      props.children
    ),
}));
vi.mock('@/components/ui/icons', () => ({
  KeyRound: 'KeyRound',
  Pencil: 'Pencil',
  Plus: 'Plus',
  Trash2: 'Trash2',
}));

// ── Harness ────────────────────────────────────────────────────────────────

export async function mount(): Promise<PasskeysView> {
  const view = await renderWithProviders(createElement(PasskeysScreen));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  return view;
}

export async function press(control: ReactTestInstance): Promise<void> {
  await act(() => {
    (control.props.onPress as () => void)();
  });
}

/**
 * Sign the screen in as another account, the way a sign-out followed by a
 * sign-in would: the panels and mutations on screen belonged to the old one.
 */
export async function switchAccount(next: Identity): Promise<void> {
  await act(() => {
    identity.set(next);
  });
}

export async function retry(control: ReactTestInstance): Promise<void> {
  await act(() => {
    (control.props.onRetry as () => void)();
  });
}

/**
 * Answer the removal confirmation the screen raised, choosing the destructive
 * action. The request carries the `onConfirm` that removes the passkey, so the
 * confirmation is driven from the captured request, not a native alert.
 */
export async function confirmRemoval(): Promise<void> {
  const request = confirmSpy.mock.calls[0]?.[0] as CapturedConfirm | undefined;
  await act(() => {
    request?.onConfirm();
  });
}

/** The catalog copy the verification panel shows on its opening step. */
export const VERIFY_TITLE = "Verify it's you";
export const VERIFY_EMAIL = 'Email me a code';
export const VERIFY_PASSKEY = 'Verify with a passkey';

/**
 * Give the screen the emailed-code proof: choose it, type the code, submit.
 * The code request and the authorization are the suite's to mock; this helper
 * only drives the panel the way a person would.
 */
export async function verifyWithCode(view: PasskeysView, code = '123456'): Promise<void> {
  await press(buttonByLabel(view, VERIFY_EMAIL));
  await waitFor(() => nodes(view, 'FormField').length === 1);
  const field = first(view, 'FormField');
  await act(() => {
    (field.props.onChangeText as (value: string) => void)(code);
  });
  await press(buttonByLabel(view, 'Verify code'));
}

function flatten(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(item => flatten(item));
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return [String(value)];
  }
  return [];
}

export function nodes(view: PasskeysView, type: string): ReactTestInstance[] {
  return view.renderer.root.findAll(node => String(node.type) === type);
}

export function first(view: PasskeysView, type: string): ReactTestInstance {
  const found = nodes(view, type)[0];
  if (!found) {
    throw new Error(`${type} not found`);
  }
  return found;
}

export function texts(view: PasskeysView): string[] {
  return nodes(view, 'Text').flatMap(node => flatten(node.props.children));
}

/**
 * The EmptyState description as text. The screen passes the creation hint as a
 * plain string and the unsupported notice as a node, so a test reads both.
 */
export function emptyDescription(view: PasskeysView): string {
  const description = first(view, 'EmptyState').props.description as
    | string
    | { props?: { children?: unknown } };
  const value = typeof description === 'string' ? description : description.props?.children;
  return flatten(value).join('');
}

export function buttonByLabel(view: PasskeysView, label: string): ReactTestInstance {
  // The empty state's one action is a `StateAction`, whose stub renders a
  // pressable; a footer action is a `Button`. Both carry their label as text.
  const button = [...nodes(view, 'Button'), ...nodes(view, 'Pressable')].find(
    node =>
      node.findAll(inner => String(inner.type) === 'Text' && inner.props.children === label)
        .length > 0
  );
  if (!button) {
    throw new Error(`Button labelled ${label} not found`);
  }
  return button;
}

export function hasButtonLabel(view: PasskeysView, label: string): boolean {
  return [...nodes(view, 'Button'), ...nodes(view, 'StateAction'), ...nodes(view, 'Pressable')].some(
    node =>
      node.props.label === label ||
      node.findAll(inner => String(inner.type) === 'Text' && inner.props.children === label)
        .length > 0
  );
}

export function rowAction(view: PasskeysView, label: string): ReactTestInstance {
  const control = nodes(view, 'Pressable').find(node => node.props.accessibilityLabel === label);
  if (!control) {
    throw new Error(`Row control ${label} not found`);
  }
  return control;
}

import { createElement, type ReactNode } from 'react';
import { type Mock, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';
import { PasskeysScreen } from './passkeys-screen';
import { renderWithProviders } from '@/test/render-with-providers';

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

type PasskeysView = Awaited<ReturnType<typeof renderWithProviders>>;

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
}));
const store = vi.hoisted(() => ({ rows: [] as unknown[] }));
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const alertSpy = vi.hoisted(() => vi.fn());
// `vi.hoisted` results cannot be exported at their declaration (vitest hoists
// them above the export), so they are exported after the declaration instead.
export { alertSpy, list, store, toastError, toastSuccess };

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
vi.mock('@/lib/auth/passkey-client', () => ({
  registerPasskey: list.register,
  passkeysSupported: list.supported,
}));
vi.mock('sonner-native', () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock('react-native', () => ({
  Alert: { alert: alertSpy },
  I18nManager: { isRTL: false },
  Modal: 'Modal',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
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
vi.mock('@/lib/format', () => ({ formatDate: () => 'Jan 1, 2026' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 0 }));
vi.mock('@/components/empty-state', () => ({
  // Renders the action so a test can reach the CTA that lives inside it.
  EmptyState: (props: { action?: ReactNode }) => createElement('EmptyState', props, props.action),
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
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

export async function retry(control: ReactTestInstance): Promise<void> {
  await act(() => {
    (control.props.onRetry as () => void)();
  });
}

/**
 * Answer the removal confirmation the screen raised, choosing the destructive
 * action. The action names the passkey it removes, so it is picked by its role,
 * not by a label a copy change would move.
 */
export async function confirmRemoval(spy: Mock): Promise<void> {
  const buttons = (
    spy.mock.calls[0] as [string, string, { text: string; style?: string; onPress?: () => void }[]]
  )[2];
  await act(() => {
    buttons.find(button => button.style === 'destructive')?.onPress?.();
  });
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
  const button = nodes(view, 'Button').find(
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
  return nodes(view, 'Button').some(
    node =>
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

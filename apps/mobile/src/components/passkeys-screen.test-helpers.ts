import { createElement } from 'react';
import { vi } from 'vitest';

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
/** A passkey the server recorded a use for, so its row carries the last-used line. */
export const USED = passkey({
  id: 'pk-3',
  name: 'Work laptop',
  created_at: '2026-03-01T00:00:00Z',
  last_used_at: '2026-03-04T05:06:07Z',
});

type PasskeysView = Awaited<ReturnType<typeof renderWithProviders>>;

// ── Hoisted mocks ──────────────────────────────────────────────────────────
// The harness lives here so the scenario file stays under the repository's
// max-lines rule, the split app-unlock-screen.test-helpers.tsx uses.

const list = vi.hoisted(() => ({
  key: ['user', 'getPasskeys'] as string[],
  queryFn: vi.fn(),
}));
const store = vi.hoisted(() => ({ rows: [] as unknown[] }));
/** The window the screen lays out in; a test sets a landscape size to read the
 *  short-window presentation and restores it afterwards. */
const windowSize = vi.hoisted(() => ({ width: 411, height: 914 }));
// `vi.hoisted` results cannot be exported at their declaration (vitest hoists
// them above the export), so they are exported after the declaration instead.
export { list, store, windowSize };

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getPasskeys: {
        queryKey: () => list.key,
        queryOptions: () => ({ queryKey: list.key, queryFn: list.queryFn }),
      },
    },
  }),
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ token: 'test-token' }) }));
vi.mock('react-native', () => ({
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
vi.mock('@/lib/format', () => ({ formatDate: () => 'Jan 1, 2026' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ KeyRound: 'KeyRound' }));

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

/** Every accessibility label the rendered tree carries, from any node type. */
export function accessibilityLabels(view: PasskeysView): string[] {
  return view.renderer.root
    .findAll(node => typeof node.props.accessibilityLabel === 'string')
    .map(node => node.props.accessibilityLabel as string);
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

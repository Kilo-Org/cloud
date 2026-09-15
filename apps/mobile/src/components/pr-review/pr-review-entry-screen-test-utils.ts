// Shared plain-function-call harness for the pr-review entry screen tests.
// The entry screen is rendered without a React renderer: state and refs live
// in a per-test slot array, so calling the component again re-reads what the
// previous call's setters wrote. The vi.mock registrations live here so the
// two test files (URL field, recents) share one wiring; a test file must
// import this module before anything that pulls the screen in.

import { vi } from 'vitest';

import type * as ReactI18next from 'react-i18next';
import type * as ReactNamespace from 'react';

import { PrReviewEntryScreen } from './pr-review-entry-screen';
import { type RecentPr } from '@/lib/pr-review/recent-prs';

import '@/i18n';

const harnessMocks = vi.hoisted(() => ({
  push: vi.fn(),
  alert: vi.fn(),
  toastError: vi.fn(),
  clipboard: { current: '' as string },
}));

// A hoisted binding cannot be exported directly; alias it for the test files.
export const mocks = harnessMocks;

// The store doubles as the recents disk: tests seed it directly and assert
// removals by reading it back.
export const store = new Map<string, string>();

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => (() => void) | undefined) => {
    effect();
  },
  useRouter: () => ({ push: harnessMocks.push }),
}));

vi.mock('expo-clipboard', () => ({
  getStringAsync: async () => {
    await Promise.resolve();
    return harnessMocks.clipboard.current;
  },
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    await Promise.resolve();
    store.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    await Promise.resolve();
    store.delete(key);
  },
}));
vi.mock('@/lib/storage-keys', () => ({ PR_REVIEW_RECENTS_KEY: 'pr-review-recents' }));
vi.mock('@/lib/auth/account-metadata-write', () => ({
  writeAccountMetadata: async (_key: string, write: () => Promise<void>) => {
    await write();
  },
  deleteAccountMetadata: async (key: string) => {
    await Promise.resolve();
    store.delete(key);
  },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: harnessMocks.alert },
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/icons', () => ({
  Clipboard: 'ClipboardIcon',
  Link2: 'Link2',
  SearchX: 'SearchX',
  X: 'X',
}));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/components/pr-review/pr-review-inbox-list', () => ({
  PrReviewInboxList: 'PrReviewInboxList',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61', primaryForeground: '#FFFFFF' }),
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: harnessMocks.toastError },
}));

// The screen's hooks run without a React renderer: state and refs live in a
// per-test slot array, so calling the component again re-reads what the
// previous call's setters wrote.
let hookSlots: unknown[] = [];
let hookIndex = 0;

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof ReactNamespace>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hookIndex;
      hookIndex += 1;
      if (!(index in hookSlots)) {
        hookSlots[index] = initial;
      }
      return [
        hookSlots[index],
        (next: unknown) => {
          hookSlots[index] =
            typeof next === 'function'
              ? (next as (prev: unknown) => unknown)(hookSlots[index])
              : next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = hookIndex;
      hookIndex += 1;
      if (!(index in hookSlots)) {
        hookSlots[index] = { current: initial };
      }
      return hookSlots[index];
    },
    useCallback: (fn: unknown) => fn,
    useMemo: (factory: () => unknown) => factory(),
  };
});

export type El = {
  type?: unknown;
  props?: Record<string, unknown>;
};

function isElement(value: unknown): value is El {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

function collect(node: unknown, typeName: string, out: El[]): void {
  if (node == null) {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collect(child, typeName, out);
    }
    return;
  }
  if (!isElement(node)) {
    return;
  }
  if (node.type === typeName) {
    out.push(node);
  }
  for (const value of Object.values(node.props ?? {})) {
    collect(value, typeName, out);
  }
}

export function findAll(tree: unknown, typeName: string): El[] {
  const out: El[] = [];
  collect(tree, typeName, out);
  return out;
}

export function find(
  tree: unknown,
  typeName: string,
  where: (props: Record<string, unknown>) => boolean
): El {
  const match = findAll(tree, typeName).find(el => where(el.props ?? {}));
  if (!match) {
    throw new Error(`no ${typeName} matched the predicate`);
  }
  return match;
}

/** A matched element's props, guaranteed present — call handlers through this. */
export function propsOf(el: El): Record<string, unknown> {
  if (!el.props) {
    throw new Error('element has no props');
  }
  return el.props;
}

export function textValues(tree: unknown): string[] {
  return findAll(tree, 'Text')
    .map(el => {
      const child = el.props?.children;
      return typeof child === 'string' ? child : '';
    })
    .filter(value => value.length > 0);
}

export function render(): unknown {
  // Re-rendering restarts the hook order but keeps the slot values, so a
  // second call re-reads what the previous call's setters wrote.
  hookIndex = 0;
  // The component is a plain function call in this harness, not a constructor.
  // eslint-disable-next-line new-cap
  return PrReviewEntryScreen();
}

/** Drop all hook state so the next render starts from its initial values. */
export function resetHookSlots(): void {
  hookSlots = [];
  hookIndex = 0;
}

/** Flush the mocked SecureStore's microtask chain to completion. */
export async function flush(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}

export async function renderLoaded(): Promise<unknown> {
  render();
  // Flush the focus-effect recents load.
  await flush();
  return render();
}

export function seedRecents(entries: RecentPr[]): void {
  store.set('pr-review-recents', JSON.stringify(entries));
}

export function storedRecents(): RecentPr[] {
  return JSON.parse(store.get('pr-review-recents') ?? '[]') as RecentPr[];
}

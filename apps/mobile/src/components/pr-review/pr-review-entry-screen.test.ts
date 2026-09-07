// The entry screen is the first route into a review for every provider
// (s7): the field must accept a GitHub PR, a GitLab MR (gitlab.com or a
// self-managed host) and a Bitbucket PR; recents must keep one row per
// provider for a same-named repository and navigate back to the row's own
// provider route. Rendered through the plain-function-call harness the
// sibling screen tests use, with the real resolver/recents logic on top of
// a mocked SecureStore.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';

import { PrReviewEntryScreen } from './pr-review-entry-screen';
import { recentPrKey, type RecentPr } from '@/lib/pr-review/recent-prs';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  alert: vi.fn(),
  toastError: vi.fn(),
  clipboard: { current: '' as string },
}));

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
  useFocusEffect: (cb: () => (() => void) | void) => {
    cb();
  },
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('expo-clipboard', () => ({
  getStringAsync: async () => mocks.clipboard.current,
}));

// The store doubles as the recents disk: tests seed it directly and assert
// removals by reading it back.
const store = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    store.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    store.delete(key);
  },
}));
vi.mock('@/lib/storage-keys', () => ({ PR_REVIEW_RECENTS_KEY: 'pr-review-recents' }));
vi.mock('@/lib/auth/account-metadata-write', () => ({
  writeAccountMetadata: async (_key: string, write: () => Promise<void>) => write(),
  deleteAccountMetadata: async (key: string) => {
    store.delete(key);
  },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: mocks.alert },
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
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
  announcingToast: { error: mocks.toastError },
}));

// The screen's hooks run without a React renderer: state and refs live in a
// per-test slot array, so calling the component again re-reads what the
// previous call's setters wrote.
let hookSlots: unknown[] = [];
let hookIndex = 0;

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hookIndex++;
      if (!(index in hookSlots)) {
        hookSlots[index] = initial;
      }
      return [
        hookSlots[index],
        (next: unknown) => {
          hookSlots[index] =
            typeof next === 'function' ? (next as (prev: unknown) => unknown)(hookSlots[index]) : next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = hookIndex++;
      if (!(index in hookSlots)) {
        hookSlots[index] = { current: initial };
      }
      return hookSlots[index];
    },
    useCallback: (fn: unknown) => fn,
    useMemo: (factory: () => unknown) => factory(),
  };
});

// Imported after the mocks so the module graph sees them.
type El = {
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

function findAll(tree: unknown, typeName: string): El[] {
  const out: El[] = [];
  collect(tree, typeName, out);
  return out;
}

function find(tree: unknown, typeName: string, where: (props: Record<string, unknown>) => boolean): El {
  const match = findAll(tree, typeName).find(el => where(el.props ?? {}));
  if (!match) {
    throw new Error(`no ${typeName} matched the predicate`);
  }
  return match;
}

function textValues(tree: unknown): string[] {
  return findAll(tree, 'Text')
    .map(el => {
      const child = el.props?.children;
      return typeof child === 'string' ? child : '';
    })
    .filter(value => value.length > 0);
}

function render(): unknown {
  hookIndex = 0;
  return PrReviewEntryScreen();
}

/** Flush the mocked SecureStore's microtask chain to completion. */
function flush(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

async function renderLoaded(): Promise<unknown> {
  render();
  // Flush the focus-effect recents load.
  await flush();
  return render();
}

function seedRecents(entries: RecentPr[]): void {
  store.set('pr-review-recents', JSON.stringify(entries));
}

function storedRecents(): RecentPr[] {
  return JSON.parse(store.get('pr-review-recents') ?? '[]') as RecentPr[];
}

const SAME_TRIPLE = { owner: 'acme', repo: 'api', number: 7, lastOpenedAt: 1_700_000_000_000 };

beforeEach(() => {
  vi.clearAllMocks();
  hookSlots = [];
  store.clear();
  mocks.clipboard.current = '';
});

afterEach(() => {
  store.clear();
});

describe('provider-neutral URL field', () => {
  it('labels and placeholders name both review nouns, no provider host', async () => {
    seedRecents([]);
    const tree = await renderLoaded();
    const input = find(tree, 'TextInput', () => true);
    expect(input.props?.placeholder).toBe('Pull request or merge request URL');
    expect(input.props?.accessibilityLabel).toBe('Enter a pull request or merge request URL');
    expect(String(input.props?.placeholder)).not.toContain('github');
  });

  it('opens a GitHub PR URL on the GitHub route', async () => {
    seedRecents([]);
    const tree = await renderLoaded();
    const input = find(tree, 'TextInput', () => true);
    (input.props?.onChangeText as (value: string) => void)(
      'https://github.com/octocat/hello-world/pull/42'
    );
    const open = render();
    (
      find(open, 'Button', p => p.accessibilityLabel === 'Open pull request or merge request')
        .props?.onPress as () => void
    )();
    expect(mocks.push).toHaveBeenCalledWith('/(app)/pr-review/octocat/hello-world/42');
  });

  it('opens a self-managed GitLab MR on the provider route with its instance', async () => {
    seedRecents([]);
    const tree = await renderLoaded();
    const input = find(tree, 'TextInput', () => true);
    (input.props?.onChangeText as (value: string) => void)(
      'https://gitlab.example.com/group/sub/repo/-/merge_requests/9'
    );
    const open = render();
    (
      find(open, 'Button', p => p.accessibilityLabel === 'Open pull request or merge request')
        .props?.onPress as () => void
    )();
    expect(mocks.push).toHaveBeenCalledWith(
      '/(app)/pr-review/gitlab/group/sub/repo/9?instance=https%3A%2F%2Fgitlab.example.com'
    );
  });

  it('opens a Bitbucket PR on the provider route', async () => {
    seedRecents([]);
    const tree = await renderLoaded();
    const input = find(tree, 'TextInput', () => true);
    (input.props?.onChangeText as (value: string) => void)(
      'https://bitbucket.org/acme/api/pull-requests/7/overview'
    );
    const open = render();
    (
      find(open, 'Button', p => p.accessibilityLabel === 'Open pull request or merge request')
        .props?.onPress as () => void
    )();
    expect(mocks.push).toHaveBeenCalledWith('/(app)/pr-review/bitbucket/acme/api/7');
  });

  it('toasts the provider-neutral invalid copy for a link no provider serves', async () => {
    seedRecents([]);
    const tree = await renderLoaded();
    const input = find(tree, 'TextInput', () => true);
    (input.props?.onChangeText as (value: string) => void)('https://example.com/blog/post');
    const open = render();
    (
      find(open, 'Button', p => p.accessibilityLabel === 'Open pull request or merge request')
        .props?.onPress as () => void
    )();
    expect(mocks.toastError).toHaveBeenCalledWith('Not a pull request or merge request link');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('paste replaces the field and opens a GitLab MR straight away', async () => {
    seedRecents([]);
    mocks.clipboard.current = 'https://gitlab.com/acme/api/-/merge_requests/3';
    const tree = await renderLoaded();
    const paste = find(
      tree,
      'Pressable',
      p => p.accessibilityLabel === 'Paste pull request or merge request link'
    );
    (paste.props?.onPress as () => Promise<void>)();
    await flush();
    expect(mocks.push).toHaveBeenCalledWith(
      '/(app)/pr-review/gitlab/acme/api/3?instance=https%3A%2F%2Fgitlab.com'
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('paste of plain text keeps the invalid toast without navigating', async () => {
    seedRecents([]);
    mocks.clipboard.current = 'just some notes';
    const tree = await renderLoaded();
    const paste = find(
      tree,
      'Pressable',
      p => p.accessibilityLabel === 'Paste pull request or merge request link'
    );
    (paste.props?.onPress as () => Promise<void>)();
    await flush();
    expect(mocks.toastError).toHaveBeenCalledWith('Not a pull request or merge request link');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('shows the clear control only once the field has text', async () => {
    seedRecents([]);
    const before = await renderLoaded();
    expect(findAll(before, 'Pressable').some(p => p.props?.accessibilityLabel === 'Clear link')).toBe(
      false
    );
    const input = find(before, 'TextInput', () => true);
    (input.props?.onChangeText as (value: string) => void)('anything');
    const after = render();
    expect(
      find(after, 'Pressable', p => p.accessibilityLabel === 'Clear link')
    ).toBeTruthy();
  });
});

describe('recents identity across providers', () => {
  beforeEach(() => {
    seedRecents([
      { ...SAME_TRIPLE, title: 'GitHub one' },
      {
        ...SAME_TRIPLE,
        title: 'GitLab one',
        platform: 'gitlab',
        instanceHint: 'https://gitlab.example.com',
      },
      { ...SAME_TRIPLE, title: 'Bitbucket one', platform: 'bitbucket' },
    ]);
  });

  it('renders one row per provider with a provider label', async () => {
    const tree = await renderLoaded();
    const rows = findAll(tree, 'View').filter(p => p.props?.testID === 'recent-row');
    expect(rows).toHaveLength(3);
    const labels = textValues(tree);
    expect(labels).toContain('GitHub');
    expect(labels).toContain('GitLab');
    expect(labels).toContain('Bitbucket');
    // The GitLab row writes the MR identity with the provider's own separator.
    expect(labels).toContain('acme/api!7');
    expect(labels).toContain('acme/api#7');
  });

  it("row presses navigate to the row's own provider route", async () => {
    const tree = await renderLoaded();
    const rowPressables = findAll(tree, 'Pressable').filter(p => p.props?.accessibilityLabel == null);
    expect(rowPressables).toHaveLength(3);
    const pushes: unknown[] = [];
    for (const row of rowPressables) {
      mocks.push.mockClear();
      (row.props?.onPress as () => void)();
      pushes.push(mocks.push.mock.calls[0]?.[0]);
    }
    // Seed order is stored order: GitHub, GitLab, Bitbucket.
    expect(pushes).toEqual([
      '/(app)/pr-review/acme/api/7',
      '/(app)/pr-review/gitlab/acme/api/7?instance=https%3A%2F%2Fgitlab.example.com',
      '/(app)/pr-review/bitbucket/acme/api/7',
    ]);
  });

  it('remove confirms with provider-neutral copy and deletes only the targeted row', async () => {
    const tree = await renderLoaded();
    const removeGitLab = find(
      tree,
      'Button',
      p => p.accessibilityLabel === 'Remove acme/api!7 from recents'
    );
    (removeGitLab.props?.onPress as () => void)();
    expect(mocks.alert).toHaveBeenCalledWith(
      'Remove from recents?',
      'This review will be removed from your recents.',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel' }),
        expect.objectContaining({ text: 'Remove' }),
      ])
    );
    const destructive = (
      mocks.alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[]
    ).find(button => button.text === 'Remove');
    destructive?.onPress?.();
    await flush();
    const remaining = storedRecents();
    expect(remaining).toHaveLength(2);
    expect(remaining.map(entry => recentPrKey(entry))).toEqual([
      'github||acme/api#7',
      'bitbucket||acme/api#7',
    ]);
  });

  it('a failed row keeps the retry CTA and provider label', async () => {
    store.clear();
    seedRecents([
      {
        ...SAME_TRIPLE,
        title: 'Broken MR',
        platform: 'gitlab',
        instanceHint: 'https://gl.acme.dev',
        lastResult: 'failed',
      },
    ]);
    const tree = await renderLoaded();
    expect(textValues(tree)).toContain("Couldn't load");
    const retry = find(tree, 'Button', p => p.accessibilityLabel === 'Retry');
    (retry.props?.onPress as () => void)();
    expect(mocks.push).toHaveBeenCalledWith(
      '/(app)/pr-review/gitlab/acme/api/7?instance=https%3A%2F%2Fgl.acme.dev'
    );
  });

  it('an empty recents store shows the neutral empty state', async () => {
    store.clear();
    seedRecents([]);
    const tree = await renderLoaded();
    const empty = find(tree, 'EmptyState', () => true);
    expect(empty.props?.title).toBe('No recent reviews');
    expect(empty.props?.description).toBe(
      "Paste a link above to start a review — it'll show up here next time."
    );
  });

  it('the recents load renders into an indicator while pending', () => {
    // getRecentPrs is still in flight on the first call: the body is the
    // spinner, never a blank that would jump the layout on arrival.
    store.set('pr-review-recents', JSON.stringify([{ ...SAME_TRIPLE, title: 'X' }]));
    const tree = render();
    expect(findAll(tree, 'ActivityIndicator').length).toBeGreaterThan(0);
  });
});

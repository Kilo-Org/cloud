// P1-F-46b: the "Submit review" affordance must be reachable from the
// Overview tab (header right) and the Files tab (floating action bar,
// see `pr-diff-floating-actions.test.tsx`). The Discussion tab is
// intentionally left without a submit affordance.
//
// This test renders the screen shell as a plain function call (the
// same pattern used by `pr-merge-sheet.test.tsx`) and walks the
// resulting tree to assert which affordances are present per tab.
// React hooks are stubbed so the call is a no-op, and every child
// component is mocked to a string node so the tree walk stays
// deterministic.

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewScreen } from './pr-review-screen';
import { type PendingReviewItem } from '@/lib/pr-review/pending-review-provider';

const routerPush = vi.fn();
const routerBack = vi.fn();
const routerCanGoBack = vi.fn(() => true);

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useState: vi.fn(
      <T,>(initial: T) => [initial, vi.fn() as () => void] as [T, (value: T) => void]
    ),
    useMemo: vi.fn(<T,>(factory: () => T) => factory()),
    useRef: vi.fn(<T,>(initial: T) => {
      const ref: React.RefObject<T> = { current: initial };
      return ref;
    }),
    useEffect: vi.fn((_effect: React.EffectCallback) => {
      // no-op; the recents backfill and merge banner focus effect
      // aren't part of P1-F-46b's reachability contract.
    }),
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
  };
});

vi.mock('expo-router', () => ({
  useFocusEffect: vi.fn(),
  useRouter: () => ({ push: routerPush, back: routerBack, canGoBack: routerCanGoBack }),
}));

vi.mock('react-native', () => ({
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  View: 'View',
  Platform: { OS: 'ios' },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: true, isError: false, isFetching: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('lucide-react-native', () => ({
  Check: () => null,
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primaryForeground: '#FFFFFF',
    foreground: '#000000',
    mutedForeground: '#6F6A61',
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubPrReview: {
      getPullRequest: { queryOptions: () => ({}), queryKey: () => [] },
      listChecks: { queryKey: () => [] },
    },
    githubApps: { getUserAuthorization: { queryKey: () => [] } },
  }),
}));

vi.mock('@/lib/pr-review/merge/merge-result-banner-store', () => ({
  consumeMergePartialSuccess: () => null,
}));

vi.mock('@/lib/pr-review/recent-prs', () => ({
  upsertRecentPr: vi.fn(),
}));

vi.mock('@/components/screen-header', () => {
  // The screen passes `headerRight` as a named slot prop. We render it
  // alongside the `children` slot so the tree walk can find the
  // Submit-review Button inside.
  const MockScreenHeader = (props: {
    headerRight?: React.ReactNode;
    children?: React.ReactNode;
  }): React.ReactElement =>
    React.createElement(
      'ScreenHeader',
      { hasHeaderRight: props.headerRight != null },
      props.headerRight,
      props.children
    );
  return { ScreenHeader: MockScreenHeader };
});
vi.mock('@/components/pr-review/merge/pr-merge-partial-success-banner', () => ({
  PrMergePartialSuccessBanner: 'PrMergePartialSuccessBanner',
}));
vi.mock('@/components/pr-review/pr-review-discussion-tab', () => ({
  PrReviewDiscussionTab: 'PrReviewDiscussionTab',
}));
vi.mock('@/components/pr-review/pr-review-files-tab', () => ({
  PrReviewFilesTab: 'PrReviewFilesTab',
}));
vi.mock('@/components/pr-review/pr-review-overview', () => ({
  PrReviewOverview: 'PrReviewOverview',
}));
vi.mock('@/components/pr-review/pr-review-tab-selector', () => ({
  PrReviewTabSelector: 'PrReviewTabSelector',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

// PendingReviewProvider is not used by PrReviewScreen directly, but
// the floating-actions test mocks this module; the screen import of
// @/lib/hooks/use-theme-colors already covers what we need. No-op
// stub here keeps the module resolvable in case any transitive import
// touches it.
vi.mock('@/lib/pr-review/pending-review-provider', () => ({
  usePendingReview: () => ({
    items: [] as PendingReviewItem[],
    addComment: vi.fn(() => undefined),
    updateComment: vi.fn(() => undefined),
    removeComment: vi.fn(() => undefined),
    clear: vi.fn(() => undefined),
  }),
}));

type FindElementArgs = {
  node: unknown;
  type: string;
  prop: string;
  value: unknown;
};

function findElement({ node, type, prop, value }: FindElementArgs): React.ReactElement | null {
  if (React.isValidElement(node)) {
    const element = node;
    const props = element.props as Record<string, unknown>;
    if (element.type === type && props[prop] === value) {
      return element;
    }
    const children = props.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        const found = findElement({ node: child, type, prop, value });
        if (found) {
          return found;
        }
      }
    } else if (children !== undefined && children !== null) {
      const found = findElement({ node: children, type, prop, value });
      if (found) {
        return found;
      }
    }
    // Also walk into named slot props that carry a React node (e.g.
    // ScreenHeader's `headerRight`), so the reachability test can
    // find a Button mounted as a named slot without knowing the
    // component shape.
    const slotProps: readonly string[] = ['headerRight'];
    for (const slot of slotProps) {
      const slotValue = props[slot];
      if (slotValue !== undefined && slotValue !== null && slotValue !== children) {
        const found = findElement({ node: slotValue, type, prop, value });
        if (found) {
          return found;
        }
      }
    }
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement({ node: child, type, prop, value });
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function findScreenHeaderSubmitButton(): React.ReactElement | null {
  // eslint-disable-next-line new-cap
  const element = PrReviewScreen({ owner: 'octocat', repo: 'hello', number: 7 });
  return findElement({
    node: element,
    type: 'Button',
    prop: 'accessibilityLabel',
    value: 'Submit review',
  });
}

describe('PrReviewScreen Submit review reachability (P1-F-46b)', () => {
  beforeEach(() => {
    routerPush.mockClear();
  });
  afterEach(() => {
    routerPush.mockReset();
  });

  it('renders the Submit review affordance on the Overview tab', () => {
    const button = findScreenHeaderSubmitButton();
    expect(button).not.toBeNull();
  });

  it('navigates to the review-submit route with owner/repo/number on press (Overview)', () => {
    const button = findScreenHeaderSubmitButton();
    if (!button) {
      throw new Error('Submit review button not found on Overview tab');
    }
    const onPress = (button.props as { onPress?: () => void }).onPress;
    onPress?.();

    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/(app)/pr-review/[owner]/[repo]/[number]/review-submit',
      params: { owner: 'octocat', repo: 'hello', number: 7 },
    });
  });
});

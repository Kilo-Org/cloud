/* eslint-disable max-lines -- Submit-review, share, merge, and inset reachability tests share the direct-invocation screen harness. */
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

import '@/i18n';
import type * as ReactI18next from 'react-i18next';
import { PrReviewScreen } from './pr-review-screen';
import { type PendingReviewItem } from '@/lib/pr-review/pending-review-provider';
import { markRecentPrFailed, upsertRecentPr } from '@/lib/pr-review/recent-prs';

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

const routerPush = vi.fn();
const routerBack = vi.fn();
const routerCanGoBack = vi.fn(() => true);
const shareMock = vi.hoisted(() => vi.fn(() => ({ action: 'sharedAction' })));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useState: vi.fn(
      <T,>(initial: T) => [initial, vi.fn() as () => void] as [T, (value: T) => void]
    ),
    useMemo: vi.fn(<T,>(factory: () => T) => factory()),
    // The provider scope context is only mounted by the provider route; the
    // GitHub route reads the fallback triple, which a null context selects.
    useContext: vi.fn(() => null),
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

vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  Share: { share: shareMock },
  View: 'View',
  Platform: { OS: 'ios' },
}));

let prQueryResult: { data: unknown; isLoading: boolean; isError: boolean; isFetching: boolean } = {
  data: undefined,
  isLoading: true,
  isError: false,
  isFetching: false,
};

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => prQueryResult,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/components/ui/icons', () => ({
  Check: () => null,
  GitMerge: () => null,
  GitPullRequest: () => null,
  Share: () => null,
}));

vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));

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
      getPullRequest: { queryOptions: () => ({ queryKey: [] }) },
      listChecks: { queryOptions: () => ({ queryKey: [] }) },
    },
    providerReview: {
      getPullRequest: { queryOptions: () => ({ queryKey: [] }) },
      listChecks: { queryOptions: () => ({ queryKey: [] }) },
      getMergeState: { queryOptions: () => ({ queryKey: [] }) },
    },
    githubApps: { getUserAuthorization: { queryKey: () => [] } },
  }),
}));

vi.mock('@/lib/pr-review/merge/merge-result-banner-store', () => ({
  consumeMergePartialSuccess: () => null,
}));

vi.mock('@/lib/pr-review/recent-prs', () => ({
  upsertRecentPr: vi.fn(),
  markRecentPrFailed: vi.fn(),
}));

// A host-node mock keeps every prop the screen passes (including
// `eyebrowNumberOfLines`) on the node the `findElement` walk inspects, so the
// test can assert the header's contract directly. `headerRight` stays a named
// slot prop, which the walker follows into.
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
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
vi.mock('@/components/detail-screen', () => ({
  DetailScreenScrollView: 'DetailScreenScrollView',
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

// The header clamps a trailing action to half the row (ScreenHeader's
// `max-w-[50%]`) and the Button's own base is `shrink-0`, so a label that
// cannot shrink keeps its width and is clipped by the screen edge at large font
// scales — the explorer found the Overview "Submit review" label cut off at
// font scale 2 (#6328). The button must bound itself with a hard max-w cap
// while keeping the shrink allowance, so the label wraps in place instead of
// clipping.
describe('PrReviewScreen Submit review header fit', () => {
  function findSubmitButton(): React.ReactElement | null {
    // eslint-disable-next-line new-cap
    const element = PrReviewScreen({ owner: 'octocat', repo: 'hello', number: 7 });
    return findElement({
      node: element,
      type: 'Button',
      prop: 'accessibilityLabel',
      value: 'Submit review',
    });
  }

  it('bounds the Submit review button so its label cannot push the cluster off-screen', () => {
    const button = findSubmitButton();
    if (!button) {
      throw new Error('Submit review button not found');
    }
    const className = (button.props as { className?: string }).className ?? '';
    // Widest the button may be with the Share and Merge icon buttons beside it
    // on the narrowest supported 320 dp viewport: 132 dp of row (288 dp of
    // px-4 content − 48 dp back control + gap − 12 dp cluster margin − 96 dp
    // Share/Merge cluster) plus the 16 dp gutter that keeps an at-cap cluster
    // on-screen. Without a cap the font-scale-2 label pushed the cluster past
    // the screen edge (#6328); the regression cannot come back uncapped.
    const cap = /max-w-\[(\d+)px\]/.exec(className);
    if (!cap) {
      throw new Error('Submit review button has no max-w cap');
    }
    expect(Number(cap[1])).toBeLessThanOrEqual(148);
  });

  it('keeps the Submit review button shrinkable so the label wraps inside the cap', () => {
    const button = findSubmitButton();
    if (!button) {
      throw new Error('Submit review button not found');
    }
    const className = (button.props as { className?: string }).className ?? '';
    expect(className).toContain('shrink');
    expect(className).not.toContain('shrink-0');
    expect(className).toContain('min-w-0');
  });

  it('lets the Submit review label wrap instead of drawing off-screen', () => {
    const button = findSubmitButton();
    if (!button) {
      throw new Error('Submit review button not found');
    }
    const label = findElement({
      node: button,
      type: 'Text',
      prop: 'className',
      value: 'shrink text-center',
    });
    if (!label) {
      throw new Error('Submit review label not found');
    }
    const labelProps = label.props as {
      numberOfLines?: number;
      allowFontScaling?: boolean;
    };
    // Wrapping, not truncation: no line cap and no disabled scaling, so a
    // large font scale wraps the label inside the cap instead of clipping it.
    expect(labelProps.numberOfLines).toBeUndefined();
    expect(labelProps.allowFontScaling).not.toBe(false);
  });
});

describe('PrReviewScreen share action', () => {
  beforeEach(() => {
    prQueryResult = {
      data: undefined,
      isLoading: true,
      isError: false,
      isFetching: false,
    };
    shareMock.mockClear();
  });

  it('renders the Share affordance in the header', () => {
    // eslint-disable-next-line new-cap
    const element = PrReviewScreen({ owner: 'octocat', repo: 'hello', number: 7 });
    const shareButton = findElement({
      node: element,
      type: 'Button',
      prop: 'accessibilityLabel',
      value: 'Share pull request',
    });
    expect(shareButton).not.toBeNull();
  });

  it('shares the URL only when no PR data is loaded yet', () => {
    // eslint-disable-next-line new-cap
    const element = PrReviewScreen({ owner: 'octocat', repo: 'hello', number: 7 });
    const shareButton = findElement({
      node: element,
      type: 'Button',
      prop: 'accessibilityLabel',
      value: 'Share pull request',
    });
    if (!shareButton) {
      throw new Error('Share button not found');
    }
    const onPress = (shareButton.props as { onPress?: () => void }).onPress;
    onPress?.();

    expect(shareMock).toHaveBeenCalledTimes(1);
    expect(shareMock).toHaveBeenCalledWith({
      message: 'https://github.com/octocat/hello/pull/7',
    });
  });

  it('shares the title and URL when the PR title is loaded', () => {
    prQueryResult = {
      data: { title: 'Fix the thing' },
      isLoading: false,
      isError: false,
      isFetching: false,
    };
    // eslint-disable-next-line new-cap
    const element = PrReviewScreen({ owner: 'octocat', repo: 'hello', number: 7 });
    const shareButton = findElement({
      node: element,
      type: 'Button',
      prop: 'accessibilityLabel',
      value: 'Share pull request',
    });
    if (!shareButton) {
      throw new Error('Share button not found');
    }
    const onPress = (shareButton.props as { onPress?: () => void }).onPress;
    onPress?.();

    expect(shareMock).toHaveBeenCalledTimes(1);
    expect(shareMock).toHaveBeenCalledWith({
      message: 'Fix the thing\nhttps://github.com/octocat/hello/pull/7',
    });
  });
});

// Owner request item 3: the header carries a Merge icon button while the PR is
// mergeable, opening the same merge sheet the Overview section pushes. A
// merged/closed PR keeps Share + Submit review and gains no Merge affordance.
describe('PrReviewScreen Merge action (owner request item 3)', () => {
  const MERGEABLE_OVERVIEW = {
    state: 'open',
    mergeable: true,
    mergeableState: 'clean',
    number: 7,
    repo: { allowMergeCommit: true, allowSquashMerge: true, allowRebaseMerge: false },
  };

  function findHeaderMergeButton(): React.ReactElement | null {
    // eslint-disable-next-line new-cap
    const element = PrReviewScreen({ owner: 'octocat', repo: 'hello', number: 7 });
    return findElement({
      node: element,
      type: 'Button',
      prop: 'accessibilityLabel',
      value: 'Merge now',
    });
  }

  beforeEach(() => {
    routerPush.mockClear();
  });
  afterEach(() => {
    routerPush.mockReset();
    vi.mocked(React.useContext).mockReturnValue(null);
  });

  it('renders the Merge affordance for a mergeable open pull request', () => {
    prQueryResult = {
      data: MERGEABLE_OVERVIEW,
      isLoading: false,
      isError: false,
      isFetching: false,
    };
    expect(findHeaderMergeButton()).not.toBeNull();
  });

  it('opens the merge sheet with the default method on press', () => {
    prQueryResult = {
      data: MERGEABLE_OVERVIEW,
      isLoading: false,
      isError: false,
      isFetching: false,
    };
    const button = findHeaderMergeButton();
    if (!button) {
      throw new Error('Merge button not found');
    }
    const onPress = (button.props as { onPress?: () => void }).onPress;
    onPress?.();

    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/(app)/pr-review/[owner]/[repo]/[number]/merge',
      params: { owner: 'octocat', repo: 'hello', number: '7', mode: 'merge', method: 'merge' },
    });
  });

  it('does not render the Merge affordance for a merged pull request', () => {
    prQueryResult = {
      data: { state: 'merged', mergeable: null, mergeableState: null },
      isLoading: false,
      isError: false,
      isFetching: false,
    };
    expect(findHeaderMergeButton()).toBeNull();
  });

  it('offers Merge for an open provider merge request and pushes its own sheet route', () => {
    // A GitLab/Bitbucket arm normalizes `mergeable` to null, so the gate keys
    // off the request state and the sheet reads the provider restrictions.
    vi.mocked(React.useContext).mockReturnValue({
      ref: { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 },
      organizationId: null,
    });
    prQueryResult = {
      data: {
        state: 'open',
        mergeable: null,
        mergeableState: null,
        number: 12,
        repo: { allowMergeCommit: true, allowSquashMerge: true, allowRebaseMerge: false },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
    };
    // eslint-disable-next-line new-cap
    const element = PrReviewScreen({ owner: 'group/sub', repo: 'repo', number: 12 });
    const button = findElement({
      node: element,
      type: 'Button',
      prop: 'accessibilityLabel',
      value: 'Merge now',
    });
    expect(button).not.toBeNull();
    if (!button) {
      throw new Error('Merge button not found for the provider arm');
    }
    const onPress = (button.props as { onPress?: () => void }).onPress;
    onPress?.();

    expect(routerPush).toHaveBeenCalledWith(
      '/(app)/pr-review/gitlab/group/sub/repo/12/merge?mode=merge&method=merge'
    );
  });
});

describe('PrReviewScreen Overview scrolling', () => {
  beforeEach(() => {
    prQueryResult = {
      data: undefined,
      isLoading: true,
      isError: false,
      isFetching: false,
    };
  });

  function findOverviewScroll(): React.ReactElement | null {
    // eslint-disable-next-line new-cap
    const element = PrReviewScreen({ owner: 'octocat', repo: 'hello', number: 7 });
    return findElement({
      node: element,
      type: 'DetailScreenScrollView',
      prop: 'contentContainerClassName',
      value: 'gap-5 px-4',
    });
  }

  it('does not wrap the Overview in a second scroller', () => {
    expect(findOverviewScroll()).toBeNull();
  });

  it('passes the refresh control to the Overview', () => {
    const renderScreen = PrReviewScreen;
    const element = renderScreen({ owner: 'octocat', repo: 'hello', number: 7 });
    const overview = findElement({
      node: element,
      type: 'PrReviewOverview',
      prop: 'isActive',
      value: true,
    });
    expect(overview).not.toBeNull();
    if (!overview) {
      throw new Error('Overview not found');
    }
    const refresh = (overview.props as { refreshControl: React.ReactElement }).refreshControl;
    expect(refresh.type).toBe('RefreshControl');
    expect((refresh.props as { onRefresh: unknown }).onRefresh).toEqual(expect.any(Function));
  });
});

// The recents store is keyed on `owner/repo#number` and its rows navigate to
// the GitHub route, so only a GitHub pull request may be written there — a
// GitLab MR filed under that key would send the user to a GitHub PR on the
// way back. This describe is the only one that runs effects: the rest of the
// file asserts render output, where the recents backfill is noise.
describe('PrReviewScreen recents backfill per provider', () => {
  const GITLAB_SCOPE = {
    ref: { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 },
    organizationId: null,
  };

  beforeEach(() => {
    vi.mocked(upsertRecentPr).mockClear();
    vi.mocked(markRecentPrFailed).mockClear();
    vi.mocked(React.useEffect).mockImplementation((effect: React.EffectCallback) => {
      effect();
    });
  });

  afterEach(() => {
    vi.mocked(React.useEffect).mockImplementation(() => undefined);
    vi.mocked(React.useContext).mockReturnValue(null);
  });

  it('writes a recents entry for a loaded GitHub pull request', () => {
    prQueryResult = {
      data: { title: 'Fix the thing' },
      isLoading: false,
      isError: false,
      isFetching: false,
    };
    // eslint-disable-next-line new-cap
    PrReviewScreen({ owner: 'octocat', repo: 'hello', number: 7 });
    expect(upsertRecentPr).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'octocat', repo: 'hello', number: 7, lastResult: 'ok' })
    );
  });

  it('marks the GitHub entry failed when the load errors', () => {
    prQueryResult = { data: undefined, isLoading: false, isError: true, isFetching: false };
    // eslint-disable-next-line new-cap
    PrReviewScreen({ owner: 'octocat', repo: 'hello', number: 7 });
    expect(markRecentPrFailed).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello',
      number: 7,
      platform: 'github',
    });
  });

  it('files a loaded GitLab merge request under its GitLab identity, never a GitHub triple', () => {
    vi.mocked(React.useContext).mockReturnValue(GITLAB_SCOPE);
    prQueryResult = {
      data: { title: 'Bump the dep' },
      isLoading: false,
      isError: false,
      isFetching: false,
    };
    // eslint-disable-next-line new-cap
    PrReviewScreen({ owner: 'group/sub', repo: 'repo', number: 12 });
    expect(upsertRecentPr).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'group/sub',
        repo: 'repo',
        number: 12,
        platform: 'gitlab',
        title: 'Bump the dep',
        lastResult: 'ok',
      })
    );
    const written = vi.mocked(upsertRecentPr).mock.calls[0]?.[0];
    expect(written?.platform).toBe('gitlab');
    // No instance hint on the scope: no hint key on the entry.
    expect(written && 'instanceHint' in written).toBe(false);
  });

  it('keeps the GitLab instance hint on the entry for identity and recents', () => {
    vi.mocked(React.useContext).mockReturnValue({
      ref: {
        platform: 'gitlab',
        projectPath: 'group/sub/repo',
        mrIid: 12,
        instanceHint: 'https://gl.acme.dev',
      },
      organizationId: null,
    });
    prQueryResult = {
      data: { title: 'Bump the dep' },
      isLoading: false,
      isError: false,
      isFetching: false,
    };
    // eslint-disable-next-line new-cap
    PrReviewScreen({ owner: 'group/sub', repo: 'repo', number: 12 });
    expect(upsertRecentPr).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'gitlab', instanceHint: 'https://gl.acme.dev' })
    );
  });

  it('marks a GitLab merge request failed on its own row, not the GitHub twin', () => {
    vi.mocked(React.useContext).mockReturnValue(GITLAB_SCOPE);
    prQueryResult = { data: undefined, isLoading: false, isError: true, isFetching: false };
    // eslint-disable-next-line new-cap
    PrReviewScreen({ owner: 'group/sub', repo: 'repo', number: 12 });
    expect(markRecentPrFailed).toHaveBeenCalledWith({
      owner: 'group/sub',
      repo: 'repo',
      number: 12,
      platform: 'gitlab',
    });
  });
});

// The header reserves the width of the trailing cluster this screen renders,
// so it can reflow the actions onto their own row before the title is squeezed
// (the finding: PR review at 320 dp with a font scale of 2).
describe('PrReviewScreen header trailing cluster width', () => {
  const MERGEABLE_OVERVIEW = {
    state: 'open',
    mergeable: true,
    mergeableState: 'clean',
    number: 7,
    repo: { allowMergeCommit: true, allowSquashMerge: true, allowRebaseMerge: false },
  };

  it('declares the width of the controls it renders', () => {
    prQueryResult = {
      data: MERGEABLE_OVERVIEW,
      isLoading: false,
      isError: false,
      isFetching: false,
    };
    // eslint-disable-next-line new-cap
    const element = PrReviewScreen({ owner: 'octocat', repo: 'hello', number: 7 });
    // Share 44 + `gap-1` 4 + Submit review 140 + `gap-1` 4 + Merge 44.
    expect(
      findElement({
        node: element,
        type: 'ScreenHeader',
        prop: 'headerRightWidth',
        value: 236,
      })
    ).not.toBeNull();
  });

  it('leaves out a control this screen does not render', () => {
    // A merged PR renders no Merge action: Share 44 + `gap-1` 4 + Submit 140.
    prQueryResult = {
      data: { state: 'merged', mergeable: null, mergeableState: null },
      isLoading: false,
      isError: false,
      isFetching: false,
    };
    // eslint-disable-next-line new-cap
    const element = PrReviewScreen({ owner: 'octocat', repo: 'hello', number: 7 });
    expect(
      findElement({
        node: element,
        type: 'ScreenHeader',
        prop: 'headerRightWidth',
        value: 188,
      })
    ).not.toBeNull();
  });
});

describe('PrReviewScreen header eyebrow cap', () => {
  beforeEach(() => {
    prQueryResult = {
      data: undefined,
      isLoading: true,
      isError: false,
      isFetching: false,
    };
  });

  it('caps the repository eyebrow to a single line so it cannot wrap onto the title', () => {
    // eslint-disable-next-line new-cap
    const element = PrReviewScreen({ owner: 'octocat', repo: 'hello', number: 7 });
    const header = findElement({
      node: element,
      type: 'ScreenHeader',
      prop: 'eyebrowNumberOfLines',
      value: 1,
    });
    expect(header).not.toBeNull();
  });
});

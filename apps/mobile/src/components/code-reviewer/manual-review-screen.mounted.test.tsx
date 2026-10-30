/* eslint-disable max-lines -- one mounted suite covers the screen's footer geometry, its recovery cases, the start-failure lifecycle and the URL validation contract on both platforms */
import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, type TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { scrollTo as scrollToSpy } from '@/test/scroll-view-mock';
import { TabBarLabelContext } from '@/lib/tab-bar-clearance';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { MANUAL_REVIEW_START_DEADLINE_MS } from './deadline-watched-start';
import { ManualReviewScreen } from './manual-review-screen';

// The explorer finding (manual-review, 2026-09-19) was the primary action
// clipped mid-label at the scroll fold, under the tab bar, at 560 density. The
// fix pins the action in a footer below the scroll view, so these tests assert
// the structural guarantee (the action is not inside the scroll viewport) and
// the footer clearance (it sits the screen's bottom clearance above the edge).
const BOTTOM_INSET = 24;
const TAB_SCREEN_BOTTOM_GAP = 16;

const platformState = vi.hoisted(() => ({ OS: 'android' }));
// The empty state's connect action is the provider app install, which only an
// organization-manage role may run; `canManage` is that role, `canEdit` the
// wider settings capability the sibling screens use.
const permissionState = vi.hoisted(() => ({
  status: 'ready' as 'loading' | 'error' | 'ready',
  canEdit: true,
  canManage: true,
}));
const status = vi.hoisted(() => ({
  connected: true,
  loading: false,
  errorCode: null as string | null,
  pending: false,
  mutate: vi.fn(),
  refetch: vi.fn(),
  push: vi.fn(),
}));
// The footer reads its keyboard lift from the root `KeyboardProvider` instead of
// listening to React Native's keyboard events. The store below is driven per
// test so the footer clearance can be asserted against a raised keyboard; the
// app-level stub in `vitest.setup.ts` always reports a hidden one.
const keyboardStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    state: { height: 0 },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setHeight: (height: number) => {
      keyboardStore.state.height = height;
      for (const listener of listeners) {
        listener();
      }
    },
  };
});

// The screen scrolls the body back to the URL section when Start rejects an
// empty or malformed URL; the shared mock records those calls so the suite can
// prove the field is revealed rather than trusting that it happened.
vi.mock('react-native', async () => {
  // `vi.mock` factories are hoisted above the file's static imports, so the
  // shared host-element mock is pulled in here too.
  const { MockScrollView } = await import('@/test/scroll-view-mock');
  return {
    Platform: {
      get OS() {
        return platformState.OS;
      },
    },
    Dimensions: { get: () => ({ height: 900 }) },
    // `@/components/ui/input` reads `I18nManager.isRTL` through
    // `@/lib/rtl-text`; the mock must expose it or the shared box throws.
    I18nManager: { isRTL: false },
    Pressable: 'Pressable',
    ScrollView: MockScrollView,
    TextInput: 'TextInput',
    View: 'View',
    useWindowDimensions: () => ({ fontScale: 1 }),
  };
});
vi.mock('react-native-keyboard-controller', async () => {
  // `vi.mock` factories are hoisted above the file's static imports, so `react`
  // must be pulled in here.
  const React = await import('react');
  const heightOf = () => keyboardStore.state.height;
  return {
    KeyboardProvider: 'KeyboardProvider',
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    KeyboardChatScrollView: 'KeyboardChatScrollView',
    useKeyboardState: (selector?: (state: Record<string, unknown>) => unknown) => {
      const height = React.useSyncExternalStore(keyboardStore.subscribe, heightOf, heightOf);
      const state = {
        height,
        isVisible: height > 0,
        progress: height > 0 ? 1 : 0,
        duration: 0,
      };
      return selector ? selector(state) : state;
    },
  };
});
// The real footer and the tab-screen clearance are used on purpose: the footer
// measures its own clearance with the real `useTabBarBottomPadding` (this screen
// no longer renders `TabScreenScrollView`, so the old tab-screen mock does not
// apply). Both read the safe-area insets through
// `react-native-safe-area-context`, whose module resolves to its untransformed
// `react-native` entry (`src/index.tsx`): the CommonJS entry requires a Flow
// react-native subpath this node project cannot load, and every mounted suite
// mocks it. So stub the module's only native dependency instead of the module
// itself, and keep the real footer and clearance.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: BOTTOM_INSET, left: 0, right: 0 }),
}));

vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  selectionAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: vi.fn(), push: status.push }),
  useFocusEffect: () => undefined,
}));
vi.mock('@/components/agents/model-selector', () => ({ ModelSelector: 'ModelSelector' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', GitPullRequest: 'GitPullRequest' }));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: 'RadioGroup',
  radioItemA11y: () => ({}),
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
// The real `@/components/tab-screen` and `@/lib/code-reviewer-status` are used
// on purpose. The footer measures its clearance with the real
// `useTabBarBottomPadding` (this screen no longer renders `TabScreenScrollView`,
// so the old tab-screen mock does not apply), and the recovery cases below
// depend on the real `classifyProviderErrorCode` to tell retryable from
// permanent failures.
vi.mock('@/lib/code-reviewer-config', () => ({
  PLATFORM_CAPABILITIES: { github: { label: 'GitHub' }, gitlab: { label: 'GitLab' } },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#ffffff',
    mutedForeground: '#888888',
    primary: '#e5e54b',
    primaryForeground: '#111111',
  }),
}));
vi.mock('@/lib/hooks/use-reviewer-models', () => ({ useReviewerModels: () => ({ models: [] }) }));
/** The permission the screen reads, driven per test through `permissionState`. */
function reviewerPermission() {
  if (permissionState.status === 'loading') {
    return { status: 'loading' as const };
  }
  if (permissionState.status === 'error') {
    return { status: 'error' as const, refetch: vi.fn(), isRetrying: false };
  }
  return {
    status: 'ready' as const,
    canEdit: permissionState.canEdit,
    canManage: permissionState.canManage,
  };
}

vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  PERSONAL_SCOPE: 'personal',
  useGitHubStatus: () => ({
    data: { connected: status.connected },
    isLoading: status.loading,
    isError: status.errorCode !== null,
    error: { data: { code: status.errorCode } },
    isFetching: false,
    refetch: status.refetch,
  }),
  useGitLabStatus: () => ({
    data: { connected: false },
    isLoading: status.loading,
    isError: status.errorCode !== null,
    error: { data: { code: status.errorCode } },
    isFetching: false,
    refetch: status.refetch,
  }),
  useReviewConfig: () => ({ data: { modelSlug: 'model-x', thinkingEffort: null } }),
  useReviewerPermission: reviewerPermission,
}));
vi.mock('@/lib/hooks/use-code-reviews', () => ({
  useCreateManualReview: () => ({ mutate: status.mutate, isPending: status.pending }),
}));

function findAllOfType(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => String(node.type) === type);
}

function only<T>(items: T[], what: string): T {
  const [item] = items;
  if (items.length !== 1 || item === undefined) {
    throw new Error(`Expected one ${what}, received ${items.length}`);
  }
  return item;
}

async function renderScreen(scope = 'personal') {
  // The root stack publishes `null`: no tab bar under this screen.
  const { renderer, unmount } = await renderWithProviders(
    createElement(TabBarLabelContext, { value: null }, createElement(ManualReviewScreen, { scope }))
  );
  return { renderer, unmount };
}

const PR_URL_PLACEHOLDER = 'https://github.com/owner/repo/pull/123';
const GITHUB_PR_URL = 'https://github.com/drain-e2e-labs/notes/pull/42';
const SERVER_RATE_LIMITED = 'GitHub is rate limiting this installation.';

/**
 * The sentence the screen renders for a retryable (TOO_MANY_REQUESTS) start
 * failure. Read from the catalog at call time, because this suite asserts where
 * and for how long the failure and its retry stay on screen; the code-to-copy
 * mapping has its own suite (`manual-review-start-failure.mounted.test.tsx`).
 */
function startFailureText(): string {
  return i18n.t('codeReviewer.manualReview.startRateLimited', {
    provider: 'GitHub',
    requestNoun: i18n.t('common.pullRequest'),
  });
}

/**
 * A failed call as the tRPC client reports it: a code plus the server's
 * message. Rate limiting is the retryable case, so the recovery control these
 * tests follow is on screen.
 */
function startFailure() {
  return Object.assign(new Error(SERVER_RATE_LIMITED), {
    data: { code: 'TOO_MANY_REQUESTS', message: SERVER_RATE_LIMITED },
  });
}

function propOf(node: TestRenderer.ReactTestInstance, key: string): unknown {
  /* eslint-disable-next-line typescript-eslint/no-unsafe-member-access -- renderer props are an index signature */
  return node.props[key];
}

/** Every string rendered through the shared `Text` mock. */
function renderedTexts(root: TestRenderer.ReactTestInstance): string[] {
  return findAllOfType(root, 'Text')
    .map(node => propOf(node, 'children'))
    .filter(child => typeof child === 'string');
}

/** The pull request URL box, told apart from the instructions box by its placeholder. */
function urlField(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return only(
    findAllOfType(root, 'TextInput').filter(
      node => propOf(node, 'placeholder') === PR_URL_PLACEHOLDER
    ),
    'pull request URL field'
  );
}

/** Every inline `paddingBottom` on the way up from a node, nearest first. */
function paddingBottomsAbove(node: TestRenderer.ReactTestInstance): number[] {
  const values: number[] = [];
  let current: TestRenderer.ReactTestInstance | null = node.parent;
  while (current) {
    /* eslint-disable typescript-eslint/no-unsafe-member-access -- renderer props are an index signature */
    const style: unknown = current.props.style;
    /* eslint-enable typescript-eslint/no-unsafe-member-access */
    const entries = Array.isArray(style) ? style : [style];
    for (const entry of entries) {
      if (entry && typeof entry === 'object' && 'paddingBottom' in entry) {
        const value: unknown = (entry as { paddingBottom?: unknown }).paddingBottom;
        if (typeof value === 'number') {
          values.push(value);
        }
      }
    }
    current = current.parent;
  }
  return values;
}

beforeEach(() => {
  keyboardStore.setHeight(0);
  permissionState.status = 'ready';
  permissionState.canEdit = true;
  permissionState.canManage = true;
  status.connected = true;
  status.loading = false;
  status.errorCode = null;
  status.pending = false;
  status.mutate.mockClear();
  status.refetch.mockClear();
  status.push.mockClear();
  scrollToSpy.mockClear();
});

describe.each(['android', 'ios'] as const)('ManualReviewScreen primary action on %s', platform => {
  beforeEach(() => {
    platformState.OS = platform;
  });

  it('pins the start action outside the scroll viewport, clear of the bottom inset', async () => {
    const { renderer, unmount } = await renderScreen();

    const scrollViews = findAllOfType(renderer.root, 'ScrollView');
    expect(scrollViews).toHaveLength(1);
    const scrollView = only(scrollViews, 'scroll view');
    // The action used to be the scroll body's last child, so a tall form
    // clipped it mid-label at the fold.
    expect(findAllOfType(scrollView, 'Button')).toHaveLength(0);

    const action = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    const [footerClearance] = paddingBottomsAbove(action);
    expect(footerClearance).toBe(BOTTOM_INSET + TAB_SCREEN_BOTTOM_GAP);

    unmount();
  });

  it('drops the bottom clearance while the keyboard lifts the footer', async () => {
    const { renderer, unmount } = await renderScreen();

    // A keyboard at least as tall as the clearance. The footer hands the whole
    // bottom space to the lift view (`KeyboardAvoidingView`), which owns it
    // while the keyboard is open, so its own clearance collapses to 0.
    const keyboardLift = platform === 'android' ? 300 : 324;
    act(() => {
      keyboardStore.setHeight(keyboardLift);
    });

    const action = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    expect(paddingBottomsAbove(action)).toEqual([0]);
    // The lift view is the sole keyboard owner while the keyboard is up.
    expect(findAllOfType(renderer.root, 'KeyboardAvoidingView')).toHaveLength(1);

    // The provider clears the height when the keyboard hides; the footer
    // restores its bottom clearance.
    act(() => {
      keyboardStore.setHeight(0);
    });
    expect(paddingBottomsAbove(action)).toEqual([BOTTOM_INSET + TAB_SCREEN_BOTTOM_GAP]);

    unmount();
  });

  it('keeps the footer clearance a short keyboard does not cover', async () => {
    const { renderer, unmount } = await renderScreen();

    // A keyboard shorter than the clearance leaves part of it uncovered; the
    // footer keeps the difference so the action never lands behind the bottom
    // edge (e1-fill).
    const keyboardLift = BOTTOM_INSET;
    act(() => {
      keyboardStore.setHeight(keyboardLift);
    });

    const action = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    expect(paddingBottomsAbove(action)).toEqual([
      BOTTOM_INSET + TAB_SCREEN_BOTTOM_GAP - keyboardLift,
    ]);

    unmount();
  });

  it('keeps the action pinned and disabled while provider status is loading', async () => {
    status.loading = true;
    status.connected = false;
    const { renderer, unmount } = await renderScreen();
    expect(findAllOfType(renderer.root, 'Skeleton')).toHaveLength(2);
    const button = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    expect((button.props as { disabled: boolean }).disabled).toBe(true);
    // The footer is the sole clearance source now (the deleted lift layer is
    // gone); at rest it reserves the screen's bottom clearance plus its final gap.
    expect(paddingBottomsAbove(button)).toEqual([BOTTOM_INSET + TAB_SCREEN_BOTTOM_GAP]);
    unmount();
  });

  it('keeps the pending action in the same footer', async () => {
    status.pending = true;
    const { renderer, unmount } = await renderScreen();
    const button = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    expect((button.props as { loading: boolean }).loading).toBe(true);
    // The footer is the sole clearance source now (the deleted lift layer is
    // gone); at rest it reserves the screen's bottom clearance plus its final gap.
    expect(paddingBottomsAbove(button)).toEqual([BOTTOM_INSET + TAB_SCREEN_BOTTOM_GAP]);
    unmount();
  });

  it.each([
    ['INTERNAL_SERVER_ERROR', true],
    ['FORBIDDEN', false],
    ['NOT_FOUND', false],
  ])('preserves the recovery action for %s', async (code, retryable) => {
    status.connected = false;
    status.errorCode = code;
    const { renderer, unmount } = await renderScreen();
    const error = only(findAllOfType(renderer.root, 'QueryError'), 'provider error');
    const { onRetry } = error.props as { onRetry?: () => void };
    expect(Boolean(onRetry)).toBe(retryable);
    if (retryable) {
      act(() => onRetry?.());
      expect(status.refetch).toHaveBeenCalledTimes(2);
    }
    expect(findAllOfType(renderer.root, 'ScrollView')).toHaveLength(0);
    expect(findAllOfType(renderer.root, 'Button')).toHaveLength(0);
    unmount();
  });

  it('offers provider connection instead of a start action when empty', async () => {
    status.connected = false;
    const { renderer, unmount } = await renderScreen();
    const empty = only(findAllOfType(renderer.root, 'EmptyState'), 'empty state');
    const { action } = empty.props as { action: { props: { onPress: () => void } } };
    act(() => {
      action.props.onPress();
    });
    expect(status.push).toHaveBeenCalledWith('/(app)/code-reviewer/personal/github');
    expect(findAllOfType(renderer.root, 'ScrollView')).toHaveLength(0);
    unmount();
  });
});

describe('ManualReviewScreen connect provider CTA', () => {
  it('renders the Connect GitHub action full-width like the PR-review connect gate', async () => {
    status.connected = false;
    const { renderer, unmount } = await renderScreen();

    const empty = only(findAllOfType(renderer.root, 'EmptyState'), 'empty state');
    const { action } = empty.props as { action: ReactElement<{ className?: string }> };
    const className = String(action.props.className);
    expect(className).toContain('w-full');
    expect(className).toContain('mt-3');

    unmount();
  });
});

describe('ManualReviewScreen empty state role gate', () => {
  const ORG_SCOPE = 'org-1';

  /** The sentence the read-only notice renders, read from the catalog. */
  function readOnlyNotice(): string {
    return i18n.t('codeReviewer.notConnectedReadOnly', { platform: 'GitHub' });
  }

  it('tells an organization member only owners and admins can connect, with no action', async () => {
    status.connected = false;
    permissionState.canEdit = false;
    permissionState.canManage = false;
    const { renderer, unmount } = await renderScreen(ORG_SCOPE);

    const empty = only(findAllOfType(renderer.root, 'EmptyState'), 'empty state');
    expect(propOf(empty, 'description')).toBe(readOnlyNotice());
    expect(propOf(empty, 'action')).toBeUndefined();
    expect(findAllOfType(renderer.root, 'Button')).toHaveLength(0);
    // It must not offer the copy that instructs a member to connect.
    expect(renderedTexts(renderer.root)).not.toContain(
      i18n.t('codeReviewer.manualReview.connectProviderDescription')
    );

    unmount();
  });

  it('withholds the action from a billing manager, who cannot install the provider app', async () => {
    status.connected = false;
    permissionState.canEdit = true;
    permissionState.canManage = false;
    const { renderer, unmount } = await renderScreen(ORG_SCOPE);

    const empty = only(findAllOfType(renderer.root, 'EmptyState'), 'empty state');
    expect(propOf(empty, 'description')).toBe(readOnlyNotice());
    expect(propOf(empty, 'action')).toBeUndefined();

    unmount();
  });

  it('keeps the connect action for an owner or admin', async () => {
    status.connected = false;
    permissionState.canManage = true;
    const { renderer, unmount } = await renderScreen(ORG_SCOPE);

    const empty = only(findAllOfType(renderer.root, 'EmptyState'), 'empty state');
    const action = propOf(empty, 'action') as ReactElement<{ onPress: () => void }>;
    expect(action).toBeDefined();
    act(() => {
      action.props.onPress();
    });
    expect(status.push).toHaveBeenCalledWith(`/(app)/code-reviewer/${ORG_SCOPE}/github`);

    unmount();
  });

  it.each(['loading', 'error'] as const)(
    'keeps the connect action while the permission is %s',
    async state => {
      status.connected = false;
      permissionState.status = state;
      const { renderer, unmount } = await renderScreen(ORG_SCOPE);

      const empty = only(findAllOfType(renderer.root, 'EmptyState'), 'empty state');
      expect(propOf(empty, 'description')).toBe(
        i18n.t('codeReviewer.manualReview.connectProviderDescription')
      );
      expect(propOf(empty, 'action')).toBeDefined();

      unmount();
    }
  );
});

describe('ManualReviewScreen failed start', () => {
  it('keeps the form and withdraws the failure when the URL is cleared', async () => {
    status.mutate.mockImplementationOnce(
      (_vars: unknown, callbacks: { onError: (error: Error) => void }) => {
        callbacks.onError(startFailure());
      }
    );
    const { renderer, unmount } = await renderScreen();

    act(() => {
      (propOf(urlField(renderer.root), 'onChangeText') as (value: string) => void)(GITHUB_PR_URL);
    });
    const action = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    act(() => {
      (propOf(action, 'onPress') as () => void)();
    });

    // The failure is reported inside the form: platform, both boxes and the
    // model stay on screen with the draft the user entered.
    expect(findAllOfType(renderer.root, 'ScrollView')).toHaveLength(1);
    expect(findAllOfType(renderer.root, 'TextInput')).toHaveLength(2);
    expect(findAllOfType(renderer.root, 'ModelSelector')).toHaveLength(1);
    expect(renderedTexts(renderer.root)).toContain(startFailureText());
    expect(renderedTexts(renderer.root)).not.toContain(SERVER_RATE_LIMITED);
    expect(findAllOfType(renderer.root, 'Button').map(node => propOf(node, 'variant'))).toContain(
      'outline'
    );

    act(() => {
      (propOf(urlField(renderer.root), 'onChangeText') as (value: string) => void)('');
    });

    // Clearing the box withdraws the failure it produced and its retry, and
    // leaves the form in place.
    expect(renderedTexts(renderer.root)).not.toContain(startFailureText());
    expect(
      findAllOfType(renderer.root, 'Button').map(node => propOf(node, 'variant'))
    ).not.toContain('outline');
    expect(findAllOfType(renderer.root, 'ScrollView')).toHaveLength(1);
    expect(findAllOfType(renderer.root, 'TextInput')).toHaveLength(2);

    unmount();
  });

  it('ignores a late failure for a draft the user has already changed', async () => {
    let finish: ((error: Error) => void) | undefined = undefined;
    status.mutate.mockImplementationOnce(
      (_vars: unknown, callbacks: { onError: (error: Error) => void }) => {
        finish = callbacks.onError;
      }
    );
    const { renderer, unmount } = await renderScreen();

    act(() => {
      (propOf(urlField(renderer.root), 'onChangeText') as (value: string) => void)(GITHUB_PR_URL);
    });
    const action = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    act(() => {
      (propOf(action, 'onPress') as () => void)();
    });

    // The request is still out when the user edits the address it was made for.
    act(() => {
      (propOf(urlField(renderer.root), 'onChangeText') as (value: string) => void)(
        `${GITHUB_PR_URL}/files`
      );
    });
    act(() => finish?.(startFailure()));

    expect(renderedTexts(renderer.root)).not.toContain(startFailureText());
    expect(
      findAllOfType(renderer.root, 'Button').map(node => propOf(node, 'variant'))
    ).not.toContain('outline');

    unmount();
  });

  it('still releases the action at the deadline after the draft changes', async () => {
    vi.useFakeTimers();
    try {
      // The request never settles and the button reports it, so only the
      // deadline can release the action.
      status.pending = true;
      status.mutate.mockImplementationOnce(() => undefined);
      const { renderer, unmount } = await renderScreen();

      const primaryAction = () =>
        only(
          findAllOfType(renderer.root, 'Button').filter(
            node => propOf(node, 'variant') !== 'outline'
          ),
          'primary action'
        );

      act(() => {
        (propOf(urlField(renderer.root), 'onChangeText') as (value: string) => void)(GITHUB_PR_URL);
      });
      act(() => {
        (propOf(primaryAction(), 'onPress') as () => void)();
      });
      expect(propOf(primaryAction(), 'loading')).toBe(true);

      // The user edits the draft while that request is still running.
      act(() => {
        (propOf(urlField(renderer.root), 'onChangeText') as (value: string) => void)(
          `${GITHUB_PR_URL}/files`
        );
      });
      act(() => {
        vi.advanceTimersByTime(MANUAL_REVIEW_START_DEADLINE_MS);
      });

      // The wait is still real, so the action comes back and the stall copy
      // explains it, even though the request was raised for older input.
      expect(propOf(primaryAction(), 'loading')).toBe(false);
      expect(renderedTexts(renderer.root)).toContain(i18n.t('common.takingLonger'));

      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ManualReviewScreen URL validation', () => {
  function findUrlField(root: TestRenderer.ReactTestInstance) {
    return only(
      root.findAll(node => String(node.type) === 'TextInput' && node.props.keyboardType === 'url'),
      'URL field'
    );
  }

  // `AccessibleStatus` renders nothing for a null message, so its visible lines
  // are the exact set of status texts on screen.
  function findVisibleStatusTexts(root: TestRenderer.ReactTestInstance) {
    return root
      .findAllByType(AccessibleStatus)
      .flatMap(statusNode => statusNode.findAllByType('Text'));
  }

  it.each(['android', 'ios'] as const)(
    'shows the localized message and an error border on %s, then clears both on edit',
    async platform => {
      platformState.OS = platform;
      const { renderer, unmount } = await renderScreen();

      // Nothing is invalid until Start is pressed: an empty field is not
      // flagged while the person is filling the form.
      expect(findVisibleStatusTexts(renderer.root)).toHaveLength(0);

      // The body reports where the URL section sits, so pressing the pinned
      // action can return to it rather than to the top of a form too short to
      // hold both the platform group and the field.
      const section = only(
        renderer.root.findAll(
          node => String(node.type) === 'View' && typeof node.props.onLayout === 'function'
        ),
        'URL section'
      );
      const onSectionLayout = section.props.onLayout as (event: {
        nativeEvent: { layout: { y: number } };
      }) => void;
      act(() => {
        onSectionLayout({ nativeEvent: { layout: { y: 320 } } });
      });

      const action = only(findAllOfType(renderer.root, 'Button'), 'primary action');
      const { onPress } = action.props as { onPress: () => void };
      act(() => {
        onPress();
      });

      // The finding: pressing Start with an empty URL left the screen
      // unchanged and put the message only in the field's accessibility label.
      // A sighted user now reads the localized copy under the field, and the
      // box itself carries the destructive border `FormField` uses.
      const message = i18n.t('codeReviewer.manualReview.invalidUrl');
      const [statusText] = findVisibleStatusTexts(renderer.root);
      expect(statusText?.props.children).toBe(message);
      if (platform === 'android') {
        expect(statusText?.props.accessibilityLiveRegion).toBe('polite');
      }
      expect(String(findUrlField(renderer.root).props.className)).toContain('border-destructive');
      // The pinned action can be pressed with the URL section above the fold;
      // the body returns to the measured section so the message is on screen.
      expect(scrollToSpy).toHaveBeenCalledWith({ y: 304, animated: true });

      act(() => {
        // The status stays visible until the person edits the field, then the
        // field is no longer invalid.
        const { onChangeText } = findUrlField(renderer.root).props as {
          onChangeText: (value: string) => void;
        };
        onChangeText('h');
      });
      expect(findVisibleStatusTexts(renderer.root)).toHaveLength(0);
      expect(String(findUrlField(renderer.root).props.className)).not.toContain(
        'border-destructive'
      );

      unmount();
    }
  );

  it('keeps the message for an invalid URL rather than only an empty one', async () => {
    platformState.OS = 'android';
    const { renderer, unmount } = await renderScreen();

    const field = findUrlField(renderer.root);
    const { onChangeText } = field.props as { onChangeText: (value: string) => void };
    act(() => {
      onChangeText('https://example.com/not-a-pr');
    });
    const action = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    const { onPress } = action.props as { onPress: () => void };
    act(() => {
      onPress();
    });

    const [statusText] = findVisibleStatusTexts(renderer.root);
    expect(statusText?.props.children).toBe(i18n.t('codeReviewer.manualReview.invalidUrl'));
    expect(String(findUrlField(renderer.root).props.className)).toContain('border-destructive');

    unmount();
  });
});

describe('ManualReviewScreen instructions field', () => {
  it('names the field after the heading above it, not the draft it holds', async () => {
    platformState.OS = 'android';
    const { renderer, unmount } = await renderScreen();

    // The heading is a sibling `Text`, not part of the field, so the field
    // carried no name of its own: the native edit-text node was named after the
    // draft. The name now comes from the same catalog key the heading renders.
    const heading = i18n.t('codeReviewer.manualReview.instructions');
    only(
      renderer.root.findAll(
        node => String(node.type) === 'Text' && node.props.children === heading
      ),
      'instructions heading'
    );
    const instructions = only(
      renderer.root.findAll(
        node => String(node.type) === 'TextInput' && node.props.multiline === true
      ),
      'instructions field'
    );
    expect(instructions.props.accessibilityLabel).toBe(heading);

    act(() => {
      (instructions.props.onChangeText as (value: string) => void)('Check the retry budget');
    });
    // Uncontrolled: the draft goes to the ref and the mutation only, so the
    // name stays the heading whether the field is empty or typed into.
    expect(instructions.props.accessibilityLabel).toBe(heading);
    expect(instructions.props.value).toBeUndefined();

    unmount();
  });
});

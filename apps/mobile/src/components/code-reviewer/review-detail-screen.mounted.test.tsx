/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */
/* eslint-disable max-lines -- the spectator describe adds a transcript-state suite on top of the existing outcome-first contract; they share one mock harness */

// Outcome-first detail-screen contract: the screen leads with the conclusion
// (status + error), then findings, council, gate, and metadata. A null council
// result renders "No findings" (not a success checkmark). A permanent error
// (NOT_FOUND/FORBIDDEN/UNAUTHORIZED) shows no Retry; a transient error does.

import { createElement, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emitPrivacyCover } from '@/lib/privacy-cover-events';

import { ReviewDetailScreen } from './review-detail-screen';

const detail = vi.hoisted(() => ({
  isLoading: false,
  isError: false,
  isFetching: false,
  error: null as { data?: { code?: string } } | null,
  data: null as unknown,
  refetch: vi.fn(),
}));

const queryErrors = vi.hoisted(() => ({
  errors: [] as {
    variant?: string;
    title?: string;
    onRetry?: () => void;
    placement?: 'center' | 'top';
  }[],
}));

const buttons = vi.hoisted(() => ({
  rendered: [] as { children?: unknown; onPress?: () => void }[],
}));
const spinningIcons = vi.hoisted(() => ({ rendered: [] as { spinning?: boolean }[] }));

const viewRenders = vi.hoisted(() => ({
  list: [] as { style?: unknown; className?: string; children?: unknown }[],
}));
const modalRenders = vi.hoisted(() => ({ list: [] as Record<string, unknown>[] }));
const nativePlatform = vi.hoisted(() => ({ OS: 'ios' }));
const sessionListRenders = vi.hoisted(() => ({ list: [] as Record<string, unknown>[] }));
const composerRenders = vi.hoisted(() => ({ list: [] as Record<string, unknown>[] }));
const spectatorQueries = vi.hoisted(() => ({
  streamInfo: {
    isLoading: false,
    isError: false,
    data: null as unknown,
    refetch: vi.fn(),
  },
  sessionMessages: {
    isLoading: false,
    isError: false,
    data: null as unknown,
    refetch: vi.fn(),
  },
}));
const statusHelpers = vi.hoisted(() => ({
  cancellable: false,
  retriggerable: false,
}));
const spectatorStream = vi.hoisted(() => ({
  createReviewSpectatorStream: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: (props: { style?: unknown; className?: string; children?: ReactNode }) => {
    viewRenders.list.push(props);
    return createElement('View', props, props.children);
  },
  Modal: (props: { visible?: boolean; children?: ReactNode }) => {
    modalRenders.list.push(props);
    return props.visible ? createElement('Modal', props, props.children) : null;
  },
  Pressable: 'Pressable',
  Platform: nativePlatform,
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
  Alert: { alert: vi.fn() },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('@/components/ui/icons', () => ({ Loader2: 'Loader2', Share: 'Share' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/components/ui/spinning-icon', () => ({
  SpinningIcon: (props: { spinning?: boolean }) => {
    spinningIcons.rendered.push(props);
    return null;
  },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Warning: 'warning', Success: 'success' },
}));
vi.mock('@kilocode/app-shared/code-review', () => ({
  isCancellableReviewStatus: () => statusHelpers.cancellable,
  isRetriggerableReviewStatus: () => statusHelpers.retriggerable,
  isInFlightReviewStatus: (status: string) =>
    status === 'pending' || status === 'queued' || status === 'running',
}));
vi.mock('@kilocode/app-shared/utils', () => ({
  fromMicrodollars: (value: unknown) => value,
}));
vi.mock('@/components/code-reviewer/review-list-screen', () => ({
  statusMeta: (status: string) => ({
    label: status === 'completed' ? 'Completed' : status,
    className: 'text-good',
  }),
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'StateSurface' }));
vi.mock('@/components/query-error', () => ({
  QueryError: (props: {
    variant?: string;
    title?: string;
    onRetry?: () => void;
    placement?: 'center' | 'top';
  }) => {
    queryErrors.errors.push(props);
    return null;
  },
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/ui/button', () => ({
  Button: (props: { children?: unknown; onPress?: () => void }) => {
    buttons.rendered.push(props);
    return props.children;
  },
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: ({ children }: { children?: unknown }) => children,
}));
vi.mock('@/lib/analytics/posthog', () => ({
  FEATURE_FLAG_PR_REVIEW: 'pr-review',
  useFeatureFlag: () => true,
}));
vi.mock('@/lib/code-reviewer-open-pr-destination', () => ({
  resolveCodeReviewerOpenPrDestination: () => ({ kind: 'external' }),
}));
vi.mock('@/lib/code-reviewer-config', () => ({
  reviewerPlatformLabel: () => 'GitHub',
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/hooks/use-code-reviews', () => ({
  useReviewDetail: () => detail,
  useCancelReview: () => ({ isPending: false, mutate: vi.fn() }),
  useRetriggerReview: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('@/lib/profile-agent-navigation', () => ({ getPrReviewPath: vi.fn() }));
vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  parseTimestamp: (value: unknown) => value,
  timeAgo: () => 'now',
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    codeReviews: {
      getReviewStreamInfo: {
        queryOptions: () => ({ queryKey: ['codeReviews.getReviewStreamInfo'] }),
      },
      getSessionMessages: {
        queryOptions: () => ({ queryKey: ['codeReviews.getSessionMessages'] }),
      },
    },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    const key = options.queryKey?.[0];
    return key === 'codeReviews.getReviewStreamInfo'
      ? spectatorQueries.streamInfo
      : spectatorQueries.sessionMessages;
  },
}));
vi.mock('@/components/code-reviewer/review-spectator-stream', () => ({
  createReviewSpectatorStream: spectatorStream.createReviewSpectatorStream,
}));
vi.mock('@/components/agents/session-message-list', () => ({
  SessionMessageList: (props: Record<string, unknown>) => {
    sessionListRenders.list.push(props);
    return null;
  },
}));
vi.mock('@/components/agents/session-detail-skeleton', () => ({
  SessionSkeletonMessages: () => null,
}));
vi.mock('@/components/agents/chat-composer', () => ({
  ChatComposer: (props: Record<string, unknown>) => {
    composerRenders.list.push(props);
    return null;
  },
}));

function collectText(node: unknown): string[] {
  if (node == null) {
    return [];
  }
  if (typeof node === 'string') {
    return [node];
  }
  if (Array.isArray(node)) {
    return node.flatMap(n => collectText(n));
  }
  if (typeof node === 'object' && 'children' in node) {
    return collectText((node as { children?: unknown }).children);
  }
  return [];
}

function makeReview(over: Record<string, unknown> = {}) {
  return {
    pr_title: 'Fix login',
    repo_full_name: 'org/repo',
    pr_number: 42,
    pr_author: 'alice',
    pr_url: 'https://github.com/org/repo/pull/42',
    status: 'completed',
    error_message: null,
    head_ref: 'feature/x',
    base_ref: 'main',
    platform: 'github',
    model: 'claude',
    created_at: '2024-01-01T00:00:00.000Z',
    started_at: null,
    completed_at: null,
    total_cost_musd: null,
    check_run_id: 123,
    rawIdsRedacted: false,
    manual_config: { agentConfig: { gate_threshold: 'critical' } },
    council_result: null,
    ...over,
  };
}

const renderers: TestRenderer.ReactTestRenderer[] = [];

function openTranscriptSheet() {
  const open = buttons.rendered.findLast(button => buttonText(button) === 'Session transcript');
  if (!open?.onPress) {
    throw new Error('Transcript button was not rendered');
  }
  act(open.onPress);
}

function mountScreen(openTranscript = false) {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(ReviewDetailScreen, { scope: 'personal', reviewId: 'rev-1' })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  renderers.push(renderer);
  if (openTranscript) {
    openTranscriptSheet();
  }
  return renderer;
}

function renderScreen(openTranscript = false): string[] {
  return collectText(mountScreen(openTranscript).toJSON());
}

afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount();
    }
  });
});

beforeEach(() => {
  detail.isLoading = false;
  detail.isError = false;
  detail.isFetching = false;
  detail.error = null;
  detail.data = null;
  detail.refetch.mockClear();
  queryErrors.errors = [];
  buttons.rendered = [];
  spinningIcons.rendered = [];
  viewRenders.list = [];
  modalRenders.list = [];
  nativePlatform.OS = 'ios';
  sessionListRenders.list = [];
  composerRenders.list = [];
  statusHelpers.cancellable = false;
  statusHelpers.retriggerable = false;
  spectatorQueries.streamInfo.isLoading = false;
  spectatorQueries.streamInfo.isError = false;
  spectatorQueries.streamInfo.data = {
    success: true,
    status: 'completed',
    agentVersion: 'v2',
    cloudAgentSessionId: null,
    organizationId: undefined,
  };
  spectatorQueries.streamInfo.refetch.mockClear();
  spectatorQueries.sessionMessages.isLoading = false;
  spectatorQueries.sessionMessages.isError = false;
  spectatorQueries.sessionMessages.data = { success: true, entries: [] };
  spectatorQueries.sessionMessages.refetch.mockClear();
  spectatorStream.createReviewSpectatorStream.mockReset();
  spectatorStream.createReviewSpectatorStream.mockResolvedValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
    retryReconnect: vi.fn(),
    destroy: vi.fn(),
  });
});

describe('ReviewDetailScreen outcome-first order', () => {
  it.each([
    ['pending', true],
    ['queued', true],
    ['running', true],
    ['completed', false],
    ['failed', false],
    ['cancelled', false],
    ['interrupted', false],
  ])('rotates the status icon for %s only while the review is in progress', (status, spinning) => {
    detail.data = {
      success: true,
      review: makeReview({ status }),
      tokenUsage: { input: 0, output: 0 },
    };

    renderScreen();

    expect(spinningIcons.rendered).toEqual([expect.objectContaining({ spinning })]);
  });

  it('leads with conclusion, then findings, council, gate, then metadata', () => {
    detail.data = {
      success: true,
      review: makeReview({
        total_cost_musd: 123,
        council_result: {
          decision: 'block',
          aggregationStrategy: 'unanimous',
          specialists: [
            {
              id: 'sec',
              name: 'Security',
              vote: 'block',
              findings: [{ path: 'a.ts', line: 1, severity: 'critical', rationale: 'unsafe' }],
            },
          ],
        },
      }),
      tokenUsage: { input: 0, output: 0 },
    };

    const texts = renderScreen();

    const idx = (marker: string) => texts.indexOf(marker);
    expect(idx('Completed')).toBeGreaterThanOrEqual(0);
    expect(idx('Findings')).toBeGreaterThan(idx('Completed'));
    expect(idx('Council')).toBeGreaterThan(idx('Findings'));
    expect(idx('Gate')).toBeGreaterThan(idx('Council'));
    expect(idx('Details')).toBeGreaterThan(idx('Gate'));
    expect(texts).toContain('$123.00');
  });

  it('shows the error message inside the conclusion', () => {
    detail.data = {
      success: true,
      review: makeReview({ error_message: 'review crashed' }),
      tokenUsage: { input: 0, output: 0 },
    };

    const texts = renderScreen();

    expect(texts).toContain('review crashed');
    expect(texts.indexOf('Completed')).toBeLessThan(texts.indexOf('review crashed'));
  });
});

describe('ReviewDetailScreen empty council', () => {
  it('renders "No findings" for a null council result (not a success checkmark)', () => {
    detail.data = {
      success: true,
      review: makeReview({ council_result: null }),
      tokenUsage: { input: 0, output: 0 },
    };

    const texts = renderScreen();

    expect(texts).toContain('No findings');
    expect(texts).not.toContain('Council');
  });

  it('renders "No findings" when every specialist has zero findings', () => {
    detail.data = {
      success: true,
      review: makeReview({
        council_result: { decision: 'pass', aggregationStrategy: 'unanimous', specialists: [] },
      }),
      tokenUsage: { input: 0, output: 0 },
    };

    const texts = renderScreen();

    expect(texts).toContain('No findings');
  });
});

describe('ReviewDetailScreen redacted check run', () => {
  it('renders "Hidden" (not "None") when the check run is redacted', () => {
    detail.data = {
      success: true,
      review: makeReview({ check_run_id: null, rawIdsRedacted: true }),
      tokenUsage: { input: 0, output: 0 },
    };

    const texts = renderScreen();

    expect(texts).toContain('Hidden');
    expect(texts).not.toContain('None');
  });
});

describe('ReviewDetailScreen findings pagination', () => {
  it('keeps earlier findings visible when "Show more" reveals the 21st', () => {
    const findings = Array.from({ length: 21 }, (_, i) => ({
      path: `f${i}.ts`,
      severity: 'nitpick',
      rationale: `r${i}`,
    }));
    detail.data = {
      success: true,
      review: makeReview({
        council_result: {
          decision: 'block',
          aggregationStrategy: 'unanimous',
          specialists: [{ id: 'sec', name: 'Security', vote: 'block', findings }],
        },
      }),
      tokenUsage: { input: 0, output: 0 },
    };

    const renderer = mountScreen();

    const before = collectText(renderer.toJSON());
    expect(before).toContain('f0.ts');
    expect(before).toContain('f19.ts');
    expect(before).not.toContain('f20.ts');

    const showMore = buttons.rendered.find(button => {
      const child = button.children as { props?: { children?: unknown } } | null;
      return child?.props?.children === 'Show more';
    });
    expect(showMore).toBeDefined();
    const onPress = showMore?.onPress;
    expect(onPress).toBeDefined();
    if (onPress) {
      act(() => {
        onPress();
      });
    }

    const after = collectText(renderer.toJSON());
    expect(after).toContain('f0.ts');
    expect(after).toContain('f19.ts');
    expect(after).toContain('f20.ts');
  });
});

describe('ReviewDetailScreen error states', () => {
  it('shows a permanent error with no Retry for NOT_FOUND', () => {
    detail.isError = true;
    detail.error = { data: { code: 'NOT_FOUND' } };
    detail.data = null;

    renderScreen();

    expect(queryErrors.errors).toHaveLength(1);
    expect(queryErrors.errors[0]?.variant).toBe('not-found');
    expect(queryErrors.errors[0]?.onRetry).toBeUndefined();
  });

  it('shows a transient error with Retry for an unknown code', () => {
    detail.isError = true;
    detail.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    detail.data = null;

    renderScreen();

    expect(queryErrors.errors).toHaveLength(1);
    expect(queryErrors.errors[0]?.variant).toBe('server');
    expect(queryErrors.errors[0]?.onRetry).toBeDefined();
  });
});

function makeStreamInfo(over: Record<string, unknown> = {}) {
  return {
    success: true,
    status: 'running',
    agentVersion: 'v2',
    cloudAgentSessionId: null,
    organizationId: undefined,
    ...over,
  };
}

function buttonText(button: { children?: unknown }) {
  return (button.children as { props?: { children?: unknown } } | null)?.props?.children;
}

describe('ReviewDetailScreen transcript sheet', () => {
  beforeEach(() => {
    detail.data = {
      success: true,
      review: makeReview({ status: 'running' }),
      tokenUsage: { input: 0, output: 0 },
    };
    spectatorQueries.streamInfo.data = makeStreamInfo({ cloudAgentSessionId: 'agent-1' });
  });

  it('shows a transcript button without mounting the transcript inline', () => {
    const texts = renderScreen();

    expect(texts).toContain('Session transcript');
    expect(texts).not.toContain('Waiting for the review transcript.');
    expect(texts).not.toContain('Done');
    expect(modalRenders.list.at(-1)?.visible).toBe(false);
    expect(sessionListRenders.list).toHaveLength(0);
    expect(spectatorStream.createReviewSpectatorStream).not.toHaveBeenCalled();
  });

  it.each(['ios', 'android'])(
    'opens and closes the native transcript sheet on %s',
    async platform => {
      nativePlatform.OS = platform;
      const connection = { connect: vi.fn(), destroy: vi.fn() };
      spectatorStream.createReviewSpectatorStream.mockResolvedValue(connection);
      const renderer = mountScreen();

      openTranscriptSheet();
      await act(async () => {
        await Promise.resolve();
      });

      const modal = modalRenders.list.at(-1);
      expect(modal?.visible).toBe(true);
      expect(modal?.animationType).toBe('slide');
      expect(modal?.presentationStyle).toBe(platform === 'ios' ? 'pageSheet' : undefined);
      expect(collectText(renderer.toJSON())).toContain('Done');
      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(composerRenders.list).toHaveLength(0);

      act(() => {
        (modal?.onRequestClose as (() => void) | undefined)?.();
      });
      expect(modalRenders.list.at(-1)?.visible).toBe(false);
      expect(connection.destroy).toHaveBeenCalledTimes(1);

      openTranscriptSheet();
      await act(async () => {
        await Promise.resolve();
      });
      expect(connection.connect).toHaveBeenCalledTimes(2);
      const done = renderer.root.findAll(
        node => (node.type as string) === 'Pressable' && node.props.accessibilityLabel === 'Done'
      )[0];
      expect(done).toBeDefined();
      act(() => {
        (done?.props.onPress as (() => void) | undefined)?.();
      });
      expect(modalRenders.list.at(-1)?.visible).toBe(false);
      expect(connection.destroy).toHaveBeenCalledTimes(2);
    }
  );

  it('closes the transcript and destroys the stream when the privacy cover activates', async () => {
    const connection = { connect: vi.fn(), destroy: vi.fn() };
    spectatorStream.createReviewSpectatorStream.mockResolvedValue(connection);
    mountScreen(true);
    await act(async () => {
      await Promise.resolve();
    });

    act(emitPrivacyCover);

    expect(modalRenders.list.at(-1)?.visible).toBe(false);
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys a pending stream connection if the sheet closes before it arrives', async () => {
    const connection = { connect: vi.fn(), destroy: vi.fn() };
    let resolveConnection: ((value: typeof connection) => void) | undefined = undefined;
    const pendingConnection = new Promise<typeof connection>(resolve => {
      resolveConnection = resolve;
    });
    spectatorStream.createReviewSpectatorStream.mockReturnValue(pendingConnection);
    mountScreen(true);

    act(() => {
      (modalRenders.list.at(-1)?.onRequestClose as (() => void) | undefined)?.();
    });
    await act(async () => {
      resolveConnection?.(connection);
      await pendingConnection;
    });

    expect(connection.connect).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });

  it('closes the previous sheet when the review changes', async () => {
    const connection = { connect: vi.fn(), destroy: vi.fn() };
    spectatorStream.createReviewSpectatorStream.mockResolvedValue(connection);
    const renderer = mountScreen(true);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      renderer.update(createElement(ReviewDetailScreen, { scope: 'personal', reviewId: 'rev-2' }));
    });

    expect(modalRenders.list.at(-1)?.visible).toBe(false);
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(spectatorStream.createReviewSpectatorStream).toHaveBeenCalledTimes(1);
  });
});

describe('ReviewDetailScreen spectator transcript', () => {
  it('renders no composer (no reply controls) beside the transcript', () => {
    detail.data = {
      success: true,
      review: makeReview({ status: 'running' }),
      tokenUsage: { input: 0, output: 0 },
    };

    renderScreen(true);

    expect(composerRenders.list).toHaveLength(0);
  });

  it('keeps cancel and retry mounted when the status helpers allow them', () => {
    statusHelpers.cancellable = true;
    statusHelpers.retriggerable = true;
    detail.data = {
      success: true,
      review: makeReview({ status: 'running' }),
      tokenUsage: { input: 0, output: 0 },
    };

    renderScreen();

    expect(buttons.rendered.some(button => buttonText(button) === 'Cancel review')).toBe(true);
    expect(buttons.rendered.some(button => buttonText(button) === 'Retry review')).toBe(true);
  });

  it('shows waiting copy for a running review without a session', () => {
    spectatorQueries.streamInfo.data = makeStreamInfo({ status: 'running' });
    detail.data = {
      success: true,
      review: makeReview({ status: 'running' }),
      tokenUsage: { input: 0, output: 0 },
    };

    const texts = renderScreen(true);

    expect(texts).toContain('Waiting for the review transcript.');
  });

  it('shows empty copy for a completed review without a session', () => {
    spectatorQueries.streamInfo.data = makeStreamInfo({ status: 'completed' });
    detail.data = {
      success: true,
      review: makeReview({ status: 'completed' }),
      tokenUsage: { input: 0, output: 0 },
    };

    const texts = renderScreen(true);

    expect(texts).toContain('No transcript for this review.');
  });

  it('shows empty copy when a completed non-v2 review has stale stream info', () => {
    spectatorQueries.streamInfo.data = makeStreamInfo({ status: 'running', agentVersion: 'v1' });
    detail.data = {
      success: true,
      review: makeReview({ status: 'completed' }),
      tokenUsage: { input: 0, output: 0 },
    };

    const texts = renderScreen(true);

    expect(texts).toContain('No transcript for this review.');
    expect(texts).not.toContain('Waiting for the review transcript.');
  });

  it('shows Retry when stream info fails', () => {
    spectatorQueries.streamInfo.data = { success: false, error: 'boom' };
    detail.data = {
      success: true,
      review: makeReview({ status: 'running' }),
      tokenUsage: { input: 0, output: 0 },
    };

    renderScreen(true);

    const spectatorError = queryErrors.errors.find(
      error => error.title === 'Could not load the review transcript.'
    );
    expect(spectatorError).toBeDefined();
    expect(spectatorError?.onRetry).toBeDefined();
    expect(spectatorError?.placement).toBeUndefined();
  });

  it('fills the sheet with the transcript and clears the bottom safe area', () => {
    spectatorQueries.streamInfo.data = makeStreamInfo({ status: 'completed' });
    spectatorQueries.sessionMessages.data = {
      success: true,
      entries: [{ timestamp: 't1', message: 'm1', eventType: 'text' }],
    };
    detail.data = {
      success: true,
      review: makeReview({ status: 'completed' }),
      tokenUsage: { input: 0, output: 0 },
    };

    renderScreen(true);

    expect(sessionListRenders.list).toHaveLength(1);
    const items = sessionListRenders.list[0]?.items as
      | { key?: string; message?: string }[]
      | undefined;
    expect(items).toHaveLength(1);
    expect(items?.[0]?.message).toBe('m1');
    expect(items?.[0]?.key).toBe('t1m10');

    const heightView = viewRenders.list.find(view => {
      const style = view.style as { height?: unknown } | undefined;
      return style && typeof style.height === 'number';
    });
    expect(heightView).toBeUndefined();
    expect(viewRenders.list.some(view => view.className === 'flex-1 gap-2')).toBe(true);
    expect(sessionListRenders.list[0]?.contentBottomInset).toBe(34);
  });

  it.each([false, true])(
    'keeps cached history after stream info fails with cached metadata %s',
    hasMetadata => {
      spectatorQueries.streamInfo.data = hasMetadata
        ? makeStreamInfo({ status: 'completed' })
        : { success: false, error: 'failed' };
      spectatorQueries.streamInfo.isError = hasMetadata;
      spectatorQueries.sessionMessages.data = {
        success: true,
        entries: [{ timestamp: 't1', message: 'Saved transcript', eventType: 'text' }],
      };
      detail.data = {
        success: true,
        review: makeReview({ status: 'completed' }),
        tokenUsage: { input: 0, output: 0 },
      };

      renderScreen(true);

      const items = sessionListRenders.list.at(-1)?.items as { message: string }[];
      expect(items).toEqual([expect.objectContaining({ message: 'Saved transcript' })]);
      expect(queryErrors.errors).toHaveLength(0);
    }
  );

  it('shows QueryError plus Retry when the session snapshot fails', () => {
    spectatorQueries.streamInfo.data = makeStreamInfo({ status: 'completed' });
    spectatorQueries.sessionMessages.data = { success: false };
    detail.data = {
      success: true,
      review: makeReview({ status: 'completed' }),
      tokenUsage: { input: 0, output: 0 },
    };

    renderScreen(true);

    const snapshotError = queryErrors.errors.find(
      error => error.title === 'Could not load the review transcript.'
    );
    expect(snapshotError).toBeDefined();
    expect(snapshotError?.onRetry).toBeDefined();
    expect(snapshotError?.placement).toBeUndefined();

    act(() => {
      snapshotError?.onRetry?.();
    });
    expect(spectatorQueries.sessionMessages.refetch).toHaveBeenCalledTimes(1);
    expect(spectatorQueries.streamInfo.refetch).not.toHaveBeenCalled();
  });

  it('keeps live rows and shows Retry after a websocket drop', async () => {
    const captured: {
      onEvent?: (event: unknown) => void;
      onDisconnected?: () => void;
    } = {};
    spectatorStream.createReviewSpectatorStream.mockImplementation(
      (input: { onEvent: (event: unknown) => void; onDisconnected: () => void }) => {
        captured.onEvent = input.onEvent;
        captured.onDisconnected = input.onDisconnected;
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
          retryReconnect: vi.fn(),
          destroy: vi.fn(),
        };
      }
    );
    spectatorQueries.streamInfo.data = makeStreamInfo({
      status: 'running',
      cloudAgentSessionId: 'agent-1',
    });
    detail.data = {
      success: true,
      review: makeReview({ status: 'running' }),
      tokenUsage: { input: 0, output: 0 },
    };

    renderScreen(true);

    expect(captured.onEvent).toBeDefined();
    await act(async () => {
      captured.onEvent?.({
        eventId: 1,
        sessionId: 's-1',
        streamEventType: 'started',
        timestamp: 't1',
        data: null,
      });
      await new Promise<void>(resolve => {
        setTimeout(resolve, 0);
      });
    });
    const liveList = sessionListRenders.list.at(-1);
    const liveItems = liveList?.items as { message?: string }[] | undefined;
    expect(liveItems).toHaveLength(1);
    expect(liveItems?.[0]?.message).toBe('Execution started');

    expect(captured.onDisconnected).toBeDefined();
    act(() => {
      captured.onDisconnected?.();
    });

    expect(buttons.rendered.some(button => buttonText(button) === 'Retry')).toBe(true);
    const afterDrop = sessionListRenders.list.at(-1);
    const afterDropItems = afterDrop?.items as { message?: string }[] | undefined;
    expect(afterDropItems?.[0]?.message).toBe('Execution started');
  });

  it('keeps a streamed row when the review turns terminal (no skeleton or empty copy)', async () => {
    const captured: { onEvent?: (event: unknown) => void } = {};
    spectatorStream.createReviewSpectatorStream.mockImplementation(
      (input: { onEvent: (event: unknown) => void }) => {
        captured.onEvent = input.onEvent;
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
          retryReconnect: vi.fn(),
          destroy: vi.fn(),
        };
      }
    );
    spectatorQueries.streamInfo.data = makeStreamInfo({
      status: 'running',
      cloudAgentSessionId: 'agent-1',
    });
    detail.data = {
      success: true,
      review: makeReview({ status: 'running' }),
      tokenUsage: { input: 0, output: 0 },
    };

    const renderer = mountScreen(true);

    expect(captured.onEvent).toBeDefined();
    await act(async () => {
      captured.onEvent?.({
        eventId: 1,
        sessionId: 's-1',
        streamEventType: 'started',
        timestamp: 't1',
        data: null,
      });
      await new Promise<void>(resolve => {
        setTimeout(resolve, 0);
      });
    });

    // The review turns terminal while rows are already streamed: the gate must
    // keep the live rows instead of flashing skeleton then empty copy.
    spectatorQueries.streamInfo.data = makeStreamInfo({
      status: 'completed',
      cloudAgentSessionId: 'agent-1',
    });
    act(() => {
      renderer.update(createElement(ReviewDetailScreen, { scope: 'personal', reviewId: 'rev-1' }));
    });

    const afterTerminal = sessionListRenders.list.at(-1);
    const items = afterTerminal?.items as { message?: string }[] | undefined;
    expect(items).toHaveLength(1);
    expect(items?.[0]?.message).toBe('Execution started');
    expect(collectText(renderer.toJSON())).not.toContain('No transcript for this review.');
  });

  it('shows a centered QueryError when the live stream errors before any row', () => {
    const captured: { onError?: () => void } = {};
    spectatorStream.createReviewSpectatorStream.mockImplementation(
      (input: { onError: () => void }) => {
        captured.onError = input.onError;
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
          retryReconnect: vi.fn(),
          destroy: vi.fn(),
        };
      }
    );
    spectatorQueries.streamInfo.data = makeStreamInfo({
      status: 'running',
      cloudAgentSessionId: 'agent-1',
    });
    detail.data = {
      success: true,
      review: makeReview({ status: 'running' }),
      tokenUsage: { input: 0, output: 0 },
    };

    renderScreen(true);

    expect(captured.onError).toBeDefined();
    act(() => {
      captured.onError?.();
    });

    const liveErrorState = queryErrors.errors.find(
      error => error.title === 'Could not load the review transcript.'
    );
    expect(liveErrorState).toBeDefined();
    expect(liveErrorState?.placement).toBeUndefined();
    expect(liveErrorState?.onRetry).toBeDefined();
  });
});

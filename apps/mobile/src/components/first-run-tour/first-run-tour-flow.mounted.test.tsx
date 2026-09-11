/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); its React 19 deprecation notice points to the DOM-based Testing Library, which cannot render this app's non-DOM tree, and @testing-library/react-native cannot be transformed by the current vitest pipeline (react-native ships Flow). See src/test/render-with-providers.tsx. */
/* eslint-disable max-lines -- every tour step state (advance, create flips, retry, waiting, connected, finish, skip) shares the one seeded-query harness. */
import { createElement, type ReactNode } from 'react';
import { environmentManager } from '@tanstack/react-query';
import { act, type default as TestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FirstRunTourFlow } from './first-run-tour-flow';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

const INSTANCES_KEY = ['activeSessions', 'listInstances'];
const HISTORY_KEY = ['cliSessionsV2', 'list'];

type InstanceFixture = {
  connectionId: string;
  name: string;
  projectName: string;
  kind: 'cli' | 'remote';
  startedAt: string | null;
  gitBranch: string | null;
};

function makeInstance(connectionId: string, name: string): InstanceFixture {
  return {
    connectionId,
    name,
    projectName: 'repo',
    kind: 'remote',
    startedAt: null,
    gitBranch: null,
  };
}

const fixtures = vi.hoisted(() => ({
  instances: { instances: [] as unknown[] },
  history: { cliSessions: [] as unknown[] },
  liveSessions: [] as { connectionId: string }[],
  liveRefetch: vi.fn(),
  userId: 'u1' as string | undefined,
  historyError: false,
  // Captured from the trpc mock so a test can assert the exact list input
  // (personal scope must be `organizationId: null`, not an omitted field).
  historyInput: undefined as Record<string, unknown> | undefined,
  // When set, the mocked mark returns a promise that never settles, standing
  // in for a slow SQLCipher write: the dismissal must not wait for it.
  hangMark: false,
  // Mutable so one test can mount the flow as iOS and assert the Android
  // hardware-back subscription is not registered there.
  platformOS: 'android' as 'android' | 'ios',
}));

const historyQueryFn = vi.hoisted(() => vi.fn());
const instancesQueryFn = vi.hoisted(() => vi.fn());
const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
}));
const navigationDispatchMock = vi.hoisted(() => vi.fn());
// Captured from the `usePreventRemove` mock so a test can drive a removal
// the way react-navigation delivers it: the beforeRemove event with the
// action to replay.
const preventRemoveHolder = vi.hoisted(() => ({
  enabled: undefined as boolean | undefined,
  callback: undefined as ((options: { data: { action: { type: string } } }) => void) | undefined,
}));
const usePreventRemoveMock = vi.hoisted(() =>
  vi.fn((enabled: boolean, handler: (options: { data: { action: { type: string } } }) => void) => {
    preventRemoveHolder.enabled = enabled;
    preventRemoveHolder.callback = handler;
  })
);
const markMock = vi.hoisted(() => vi.fn<(userId: string, status: string) => void>());
const dismissalOrder = vi.hoisted(() => [] as string[]);
const setFirstRunTourOpenMock = vi.hoisted(() => vi.fn());
// Captured from the mocked BackHandler so a test can deliver a hardware-back
// press the way Android does — through the JS subscription chain, before the
// react-navigation container's own listener.
const backHolder = vi.hoisted(() => ({
  handler: undefined as (() => boolean) | undefined,
  addCount: 0,
  removeCount: 0,
}));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Platform: {
    get OS() {
      return fixtures.platformOS;
    },
  },
  I18nManager: { isRTL: false },
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      backHolder.handler = handler;
      backHolder.addCount += 1;
      return {
        remove: () => {
          backHolder.handler = undefined;
          backHolder.removeCount += 1;
        },
      };
    },
  },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  LinearTransition: {},
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key, language: 'en' } }));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return {
    useRouter: () => routerMock,
    useNavigation: () => ({ dispatch: navigationDispatchMock }),
    useFocusEffect: (effect: () => (() => void) | undefined) => {
      useEffect(() => effect(), [effect]);
    },
    useLocalSearchParams: () => ({}),
  };
});
vi.mock('@/lib/navigation/prevent-remove', () => ({
  usePreventRemove: usePreventRemoveMock,
}));
vi.mock('@/components/screen-header', () => ({
  // Render the header slots so the test can find the Skip pressable and read
  // the title/eyebrow the flow passes.
  ScreenHeader: ({
    title,
    eyebrow,
    headerRight,
  }: {
    title?: string;
    eyebrow?: string;
    headerRight?: ReactNode;
  }) => createElement('HeaderMock', null, title ?? '', eyebrow ?? '', headerRight),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/empty-state', () => ({
  // Render the slots so the instances-error test can find the title text and
  // press the Retry action the flow passes as a prop.
  EmptyState: ({
    title,
    description,
    action,
  }: {
    title?: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
  }) => createElement('EmptyState', null, title ?? '', description ?? '', action),
}));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  Cloud: 'Cloud',
  Monitor: 'Monitor',
  Server: 'Server',
  Sparkles: 'Sparkles',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', primary: '#111', mutedForeground: '#666' }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: fixtures.userId }),
}));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useLiveAgentSessions: () => ({
    activeSessions: fixtures.liveSessions,
    refetch: fixtures.liveRefetch,
  }),
}));
// The flow marks the tour open for the foreground notification handler while
// it is focused; the real module pulls in native notification wiring.
vi.mock('@/lib/notifications', () => ({
  setFirstRunTourOpen: setFirstRunTourOpenMock,
}));
// The barrel re-exports the leaf state module; mocking the leaf keeps the
// pure `classifyTourFacts` real while the persisted mark is observable.
vi.mock('@/lib/first-run-tour/tour-state', () => ({
  firstRunTourStorageKey: (userId: string) => `first-run-tour-${userId}`,
  isFirstRunTourStatus: (value: unknown) => value === 'done' || value === 'skipped',
  parseFirstRunTourRecord: () => null,
  loadFirstRunTourDecision: () => null,
  hasRecordedFirstRunTourOutcome: () => false,
  markFirstRunTourStatus: async (userId: string, status: string) => {
    dismissalOrder.push('mark');
    markMock(userId, status);
    if (fixtures.hangMark) {
      await new Promise<void>(resolve => {
        // Deliberately never resolved; `resolve` is referenced so the
        // executor is a real body, not an empty function.
        void resolve;
      });
    }
  },
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    activeSessions: {
      listInstances: {
        queryOptions: (_input: undefined, options: object) => ({
          queryKey: ['activeSessions', 'listInstances'],
          queryFn: instancesQueryFn,
          // The flow pins `retry: 1` after spreading these options (exactly
          // like the picker); zero backoff makes the settled error state
          // observable inside the act cycles instead of after a real 1 s.
          retryDelay: 0,
          ...options,
        }),
      },
    },
    cliSessionsV2: {
      list: {
        queryOptions: (input: Record<string, unknown>, options: object) => {
          fixtures.historyInput = input;
          return {
            queryKey: ['cliSessionsV2', 'list'],
            queryFn: historyQueryFn,
            // Zero backoff so a failed re-probe settles (and its retryable
            // state is observable) inside the act cycles instead of after a
            // real 1 s per attempt; mirrors the instances mock above.
            retryDelay: 0,
            ...options,
          };
        },
      },
    },
  }),
}));

const mounted: Awaited<ReturnType<typeof renderWithProviders>>[] = [];

function seedQueryClient(options: { seedInstances?: boolean } = {}) {
  const { seedInstances = true } = options;
  const queryClient = createTestQueryClient();
  // Skipping the instances seed leaves that query pending/fetching, which is
  // how the cli-step loading and error states are exercised.
  if (seedInstances) {
    queryClient.setQueryData(INSTANCES_KEY, fixtures.instances);
  }
  queryClient.setQueryData(HISTORY_KEY, fixtures.history);
  return queryClient;
}

async function mountTour(options: { seedInstances?: boolean } = {}) {
  const result = await renderWithProviders(createElement(FirstRunTourFlow), {
    queryClient: seedQueryClient(options),
  });
  mounted.push(result);
  return { root: result.renderer.root, queryClient: result.queryClient };
}

function textOf(node: TestRenderer.ReactTestInstance): string {
  const children = (node.props as { children?: unknown }).children;
  if (typeof children === 'string') {
    return children;
  }
  if (Array.isArray(children)) {
    return children.filter(child => typeof child === 'string').join(' ');
  }
  return '';
}

function findByText(root: TestRenderer.ReactTestInstance, needle: string) {
  return root.findAll(node => textOf(node).includes(needle));
}

function expectText(root: TestRenderer.ReactTestInstance, needle: string) {
  expect(findByText(root, needle).length).toBeGreaterThan(0);
}

function expectNoText(root: TestRenderer.ReactTestInstance, needle: string) {
  expect(findByText(root, needle)).toHaveLength(0);
}

async function pressText(root: TestRenderer.ReactTestInstance, needle: string) {
  const matches = findByText(root, needle);
  const target = matches.at(-1);
  if (!target) {
    throw new Error(`no node renders "${needle}"`);
  }
  let node: TestRenderer.ReactTestInstance | null = target;
  while (node && typeof (node.props as { onPress?: unknown }).onPress !== 'function') {
    node = node.parent;
  }
  if (!node) {
    throw new Error(`no pressable ancestor renders "${needle}"`);
  }
  await act(async () => {
    (node.props as { onPress: () => void }).onPress();
    // Drain the full microtask chain (mark flush -> router.back) plus the
    // react-query scheduler before the next assertion.
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

// Same walk as pressText but hands back the handler instead of invoking it,
// so a test can interleave a press with guard events inside one act cycle.
function findPressable(root: TestRenderer.ReactTestInstance, needle: string): () => void {
  const matches = findByText(root, needle);
  const target = matches.at(-1);
  if (!target) {
    throw new Error(`no node renders "${needle}"`);
  }
  let node: TestRenderer.ReactTestInstance | null = target;
  while (node && typeof (node.props as { onPress?: unknown }).onPress !== 'function') {
    node = node.parent;
  }
  if (!node) {
    throw new Error(`no pressable ancestor renders "${needle}"`);
  }
  return (node.props as { onPress: () => void }).onPress;
}

// React 19's types reject arbitrary strings in findAllByType; the mocked
// host components are string types, so count them by walking the tree.
function countTyped(root: TestRenderer.ReactTestInstance, typeName: string): number {
  return root.findAll(node => String(node.type) === typeName).length;
}

function findButtonByLabel(
  root: TestRenderer.ReactTestInstance,
  needle: string
): TestRenderer.ReactTestInstance | undefined {
  const [label] = findByText(root, needle);
  let node: TestRenderer.ReactTestInstance | null = label ?? null;
  while (node && String(node.type) !== 'Button') {
    node = node.parent;
  }
  return node ?? undefined;
}

// The tour opens on the fork; each helper picks a path from it. The cloud
// option reuses the instance picker's `Cloud Agent` label, the computer
// option is the tour's own key.
async function advanceToCloud(root: TestRenderer.ReactTestInstance) {
  await pressText(root, 'agentChat.instancePicker.cloudAgent');
}

async function advanceToCli(root: TestRenderer.ReactTestInstance) {
  await pressText(root, 'firstRunTour.computerOption');
}

// A back-type removal reaching react-navigation (a replayed dismissal, or
// the iOS swipe): the beforeRemove event with the action to replay. The
// mounted harness has no navigator, so the guard's captured callback stands
// in for that event. Android hardware back itself is consumed by the tour's
// BackHandler subscription (see the hardware-back tests below) and enters
// this path through router.back().
async function triggerHardwareBack(): Promise<{ type: string }> {
  const action = { type: 'GO_BACK' };
  await act(async () => {
    preventRemoveHolder.callback?.({ data: { action } });
    // Drain the microtask chain (mark flush -> replay dispatch).
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
  return action;
}

beforeEach(() => {
  vi.clearAllMocks();
  navigationDispatchMock.mockReset();
  preventRemoveHolder.enabled = undefined;
  preventRemoveHolder.callback = undefined;
  backHolder.handler = undefined;
  backHolder.addCount = 0;
  backHolder.removeCount = 0;
  fixtures.platformOS = 'android';
  fixtures.hangMark = false;
  fixtures.instances = { instances: [] };
  fixtures.history = { cliSessions: [] };
  fixtures.liveSessions = [];
  fixtures.userId = 'u1';
  fixtures.historyError = false;
  fixtures.historyInput = undefined;
  dismissalOrder.length = 0;
  historyQueryFn.mockImplementation(async () => {
    await Promise.resolve();
    if (fixtures.historyError) {
      throw new Error('offline');
    }
    return fixtures.history;
  });
  instancesQueryFn.mockImplementation(() => fixtures.instances);
});

afterEach(() => {
  for (const result of mounted.splice(0)) {
    result.unmount();
  }
});

describe('FirstRunTourFlow (mounted)', () => {
  it('marks the tour on screen for the push handler and clears it on unmount', async () => {
    // The cloud leg's session-ready push would otherwise drop its heads-up
    // banner onto this header, clipping the step title (spot-check defect on
    // e2-cloud-step-digest).
    const result = await renderWithProviders(createElement(FirstRunTourFlow), {
      queryClient: seedQueryClient(),
    });
    expect(setFirstRunTourOpenMock).toHaveBeenCalledWith(true);

    result.unmount();
    expect(setFirstRunTourOpenMock).toHaveBeenCalledWith(false);
  });

  it('opens on the fork: it asks where to run Kilo and offers both paths', async () => {
    const { root } = await mountTour();
    expectText(root, 'firstRunTour.chooseTitle');
    expectText(root, 'firstRunTour.chooseBody');
    expectText(root, 'agentChat.instancePicker.cloudAgent');
    expectText(root, 'agentChat.instancePicker.cloudAgentDescription');
    expectText(root, 'firstRunTour.computerOption');
    expectText(root, 'firstRunTour.computerOptionDescription');
    // No leg's copy leaks into the fork.
    expectNoText(root, 'firstRunTour.cloudBody');
    expectNoText(root, 'firstRunTour.cliTitle');
    // The history list must be read in personal scope: an omitted
    // organizationId is a cross-organization read server-side.
    expect(fixtures.historyInput).toMatchObject({ organizationId: null });
  });

  it('choosing the cloud path opens the cloud leg', async () => {
    const { root } = await mountTour();
    await advanceToCloud(root);
    expectText(root, 'firstRunTour.cloudTitle');
    expectText(root, 'firstRunTour.cloudBody');
    expectNoText(root, 'firstRunTour.chooseTitle');
  });

  it('choosing the computer path opens the CLI leg', async () => {
    fixtures.history = { cliSessions: [{ cloud_agent_session_id: 'cas-1' }] };
    const { root } = await mountTour();
    await advanceToCli(root);
    expectText(root, 'firstRunTour.cliTitle');
    expectText(root, 'firstRunTour.waitingForComputer');
    expectNoText(root, 'firstRunTour.chooseTitle');
  });

  it('cloud step pushes the new-session route for a person without a cloud session', async () => {
    const { root } = await mountTour();
    await advanceToCloud(root);
    expectText(root, 'common.newSession');

    await pressText(root, 'common.newSession');
    expect(routerMock.push).toHaveBeenCalledWith('/(app)/agent-chat/new');
  });

  it('a cloud history row flips the created line and swaps the CTA to Done', async () => {
    fixtures.history = { cliSessions: [{ cloud_agent_session_id: 'cas-1' }] };
    const { root } = await mountTour();
    await advanceToCloud(root);

    expectText(root, 'firstRunTour.cloudSessionCreated');
    expectNoText(root, 'common.newSession');
    // The waiting skeleton is gone once the leg's outcome exists.
    expect(countTyped(root, 'Skeleton')).toBe(0);

    // The cloud path ends at its own outcome with its own Done control,
    // which records the per-account decision and dismisses; it does not
    // continue into the CLI leg.
    routerMock.back.mockImplementation(() => {
      dismissalOrder.push('back');
    });
    await pressText(root, 'common.done');
    expect(markMock).toHaveBeenCalledWith('u1', 'done');
    expect(dismissalOrder).toEqual(['mark', 'back']);
    expectNoText(root, 'firstRunTour.cliTitle');
  });

  it('a settled cloud read without a session still reserves a visible loading row', async () => {
    // Spot-backlog defect e6-cloud-nextjs-down (2026-09-10): the cloud step's
    // status slot must never be blank while the leg's outcome is unknown. The
    // captured defect was a settled no-session read (the probe succeeded before
    // the injected fault), where `isFetching` was false and nothing rendered.
    // The waiting skeleton now covers that window too.
    const { root } = await mountTour();
    await advanceToCloud(root);

    expectText(root, 'common.newSession');
    expect(countTyped(root, 'Skeleton')).toBe(1);
    expectNoText(root, 'share.retryableMessage');
  });

  it('the cloud step flips when the created row turns visible after the one-shot probes (e12)', async () => {
    // SPOT-DEFECT e12 (device, 2026-09-09): the person creates the cloud
    // session on the pushed form and returns to the tour; the step kept
    // showing the initial copy and the New session CTA. The history query
    // was probed only at mount, at create-time invalidation, and by the
    // single focus refetch — a probe that lands before the row turns
    // visible on the read path left the step stuck in its initial state
    // forever, with no re-probe and no CTA flip. The cloud leg now re-probes
    // on the tour's poll cadence while it waits for its evidence; this test
    // drives exactly that sequence: mount with no session, advance to the
    // cloud step, deliver the row on the NEXT POLL TICK — no focus event,
    // no user action — and assert the defect's end state.
    // mirrors POLL_INTERVAL_MS in the flow
    const TOUR_POLL_MS = 10_000;
    // react-query skips refetchInterval scheduling in a server environment
    // (`typeof window === 'undefined'` — true in this node test env, false on
    // the device where Hermes defines `window`). Report non-server for this
    // test so the interval mechanism under test actually arms, exactly as it
    // does on device.
    const wasServer = environmentManager.isServer();
    environmentManager.setIsServer(() => false);
    vi.useFakeTimers();
    try {
      fixtures.history = { cliSessions: [] };
      const { root } = await mountTour();
      // Settle the mount fetch through the query scheduler's 0-delay timer.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Advance to the cloud step (pressText drains with a real
      // setTimeout(0), which fake timers would freeze, so press directly).
      const chooseCloud = findPressable(root, 'agentChat.instancePicker.cloudAgent');
      await act(async () => {
        chooseCloud();
        await vi.advanceTimersByTimeAsync(0);
      });

      // The defect's starting state: initial CTA, no success line.
      expectText(root, 'common.newSession');
      expectNoText(root, 'firstRunTour.cloudSessionCreated');
      // Only the mount-time probes have run so far (the focus-refetch effect
      // plus the seeded fetch): the step itself must not have polled yet.
      const probesBeforePoll = historyQueryFn.mock.calls.length;

      // The row turns visible after the one-shot probes missed it: the next
      // cloud-step poll tick delivers it — no focus event, no user action.
      fixtures.history = { cliSessions: [{ cloud_agent_session_id: 'cas-1' }] };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TOUR_POLL_MS);
      });
      // The poll's fetch settles a microtask chain after the timer fires;
      // drain it so the observer notification lands inside an act cycle.
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- draining react-query's notify scheduler needs sequential act cycles
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
      }

      expectText(root, 'firstRunTour.cloudSessionCreated');
      expectText(root, 'common.done');
      expectNoText(root, 'common.newSession');
      // The poll fired exactly once for the tick, and the step flipped.
      expect(historyQueryFn.mock.calls.length).toBe(probesBeforePoll + 1);

      // The interval stops once the evidence is in: no further probes while
      // the (now satisfied) cloud step stays on screen.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3 * TOUR_POLL_MS);
      });
      expect(historyQueryFn.mock.calls.length).toBe(probesBeforePoll + 1);
    } finally {
      vi.useRealTimers();
      // Restore the captured node default (no `window` → server) so no other
      // test in this file inherits the device-like timer behavior.
      environmentManager.setIsServer(() => wasServer);
    }
  });

  it('history-query error shows the retry line and keeps the CTAs enabled', async () => {
    fixtures.historyError = true;
    const { root } = await mountTour();
    await advanceToCloud(root);
    await waitFor(() => findByText(root, 'share.retryableMessage').length > 0);

    expectText(root, 'share.retryableMessage');
    expectText(root, 'common.newSession');
    historyQueryFn.mockClear();
    await pressText(root, 'common.retry');
    expect(historyQueryFn).toHaveBeenCalled();

    // The primary CTA still works while the history query is failing.
    historyQueryFn.mockImplementation(() => fixtures.history);
    await pressText(root, 'common.newSession');
    expect(routerMock.push).toHaveBeenCalledWith('/(app)/agent-chat/new');
  });

  it('a slow mid-tour re-probe shows the loading row instead of a blank status slot', async () => {
    // Spot-backlog defect e6-cloud-nextjs-down (2026-09-10): with a cached
    // snapshot and no cloud session, a mid-tour re-probe that HUNG on a dead
    // network rendered the status slot blank — neither loading, error, nor
    // empty. The skeleton must track every in-flight read, not only the very
    // first one.
    const { root, queryClient } = await mountTour();
    await advanceToCloud(root);
    expectNoText(root, 'share.retryableMessage');

    // The re-probe never settles: the slot is busy, so it shows the loading
    // row rather than nothing.
    historyQueryFn.mockImplementation(async () => {
      // Deliberately never settles; stands in for a hung read.
      await new Promise<never>(() => {
        // Never resolves.
      });
    });
    await act(async () => {
      void queryClient.refetchQueries({ queryKey: HISTORY_KEY });
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
    expect(countTyped(root, 'Skeleton')).toBeGreaterThan(0);
    expectNoText(root, 'share.retryableMessage');
    // The primary CTA still works while the re-probe hangs.
    expectText(root, 'common.newSession');
  });

  it('a failed mid-tour re-probe shows the retry line and Retry recovers it', async () => {
    const { root, queryClient } = await mountTour();
    await advanceToCloud(root);
    expectNoText(root, 'share.retryableMessage');

    fixtures.historyError = true;
    await act(async () => {
      void queryClient.refetchQueries({ queryKey: HISTORY_KEY });
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
    await waitFor(() => findByText(root, 'share.retryableMessage').length > 0);
    expectText(root, 'share.retryableMessage');
    expectText(root, 'common.retry');
    expectText(root, 'common.newSession');

    // Retry re-probes and the slot recovers.
    fixtures.historyError = false;
    historyQueryFn.mockClear();
    await pressText(root, 'common.retry');
    expect(historyQueryFn).toHaveBeenCalled();
    await waitFor(() => findByText(root, 'share.retryableMessage').length === 0);
  });

  it('cli step with zero instances shows the waiting line with Refresh and disabled Done', async () => {
    fixtures.history = { cliSessions: [{ cloud_agent_session_id: 'cas-1' }] };
    const { root } = await mountTour();
    await advanceToCli(root);

    expectText(root, 'firstRunTour.waitingForComputer');
    expectText(root, 'common.refresh');
    const done = findButtonByLabel(root, 'common.done');
    if (!done) {
      throw new Error('Done button is missing');
    }
    expect((done.props as { disabled?: boolean }).disabled).toBe(true);

    instancesQueryFn.mockClear();
    fixtures.liveRefetch.mockClear();
    await pressText(root, 'common.refresh');
    expect(instancesQueryFn).toHaveBeenCalled();
    expect(fixtures.liveRefetch).toHaveBeenCalled();
  });

  it('cli step shows two skeleton lines while the instances query is loading', async () => {
    fixtures.history = { cliSessions: [{ cloud_agent_session_id: 'cas-1' }] };
    // A fetch that never settles keeps the query pending, so the shared
    // picker classification resolves to `loading` (two status-line skeletons).
    instancesQueryFn.mockImplementation(async () => {
      // Never settles, so the query stays pending and the shared picker
      // classification resolves to `loading` (two status-line skeletons).
      await new Promise<unknown>(resolve => {
        // Deliberately never resolved; `resolve` is referenced so the
        // executor is a real body, not an empty function.
        void resolve;
      });
    });
    const { root } = await mountTour({ seedInstances: false });
    await advanceToCli(root);

    expect(countTyped(root, 'Skeleton')).toBe(2);
    expectNoText(root, 'firstRunTour.waitingForComputer');
    expectNoText(root, 'agentChat.instancePicker.couldNotLoad');
    const done = findButtonByLabel(root, 'common.done');
    if (!done) {
      throw new Error('Done button is missing');
    }
    expect((done.props as { disabled?: boolean }).disabled).toBe(true);
  });

  it('cli step shows the EmptyState with a working Retry when the instances query errors', async () => {
    fixtures.history = { cliSessions: [{ cloud_agent_session_id: 'cas-1' }] };
    instancesQueryFn.mockRejectedValue(new Error('offline'));
    const { root } = await mountTour({ seedInstances: false });
    await advanceToCli(root);
    await waitFor(() => findByText(root, 'agentChat.instancePicker.couldNotLoad').length > 0);

    expectText(root, 'organization.boundary.loadErrorMessage');
    expect(countTyped(root, 'EmptyState')).toBeGreaterThan(0);
    const done = findButtonByLabel(root, 'common.done');
    if (!done) {
      throw new Error('Done button is missing');
    }
    expect((done.props as { disabled?: boolean }).disabled).toBe(true);

    instancesQueryFn.mockClear();
    await pressText(root, 'common.retry');
    expect(instancesQueryFn).toHaveBeenCalled();
  });

  it('a connected instance without a live session shows the wait with Refresh and keeps Done disabled', async () => {
    fixtures.history = { cliSessions: [{ cloud_agent_session_id: 'cas-1' }] };
    fixtures.instances = { instances: [makeInstance('conn-1', 'MyMac')] };
    const { root } = await mountTour();
    await advanceToCli(root);

    expectText(root, 'firstRunTour.computerConnected');
    expectText(root, '"name":"MyMac"');
    expectNoText(root, 'firstRunTour.cliSessionCreated');
    // The tour's outcome is a live `kilo remote` session, not the mere
    // connection: Done stays disabled, and the session-poll lag is a labeled
    // loading line with a Refresh — a bare skeleton bar here read as an empty
    // control beside Refresh (spot-check defect on am2real-seg2-cli-07.png,
    // 2026-09-10), so no skeleton renders in this state.
    const done = findButtonByLabel(root, 'common.done');
    if (!done) {
      throw new Error('Done button is missing');
    }
    expect((done.props as { disabled?: boolean }).disabled).toBe(true);
    expectText(root, 'common.loading');
    expect(countTyped(root, 'Skeleton')).toBe(0);
    expectText(root, 'common.refresh');

    // The CLI-leg CTA promises a session on the connected computer: the push
    // must carry that instance's connectionId so the form pre-selects it as
    // the run-on target instead of defaulting to a Cloud Agent session.
    await pressText(root, 'firstRunTour.startOnYourComputer');
    expect(routerMock.push).toHaveBeenCalledWith('/(app)/agent-chat/new?connectionId=conn-1');
  });

  it('a live session on the connected instance clears the wait and enables Done', async () => {
    fixtures.history = { cliSessions: [{ cloud_agent_session_id: 'cas-1' }] };
    fixtures.instances = { instances: [makeInstance('conn-1', 'MyMac')] };
    const { root, queryClient } = await mountTour();
    await advanceToCli(root);

    // The waiting row's Refresh covers both sources the outcome is
    // classified from, so it can actually end the wait.
    instancesQueryFn.mockClear();
    fixtures.liveRefetch.mockClear();
    await pressText(root, 'common.refresh');
    expect(instancesQueryFn).toHaveBeenCalled();
    expect(fixtures.liveRefetch).toHaveBeenCalled();

    // A live `kilo remote` session appears on the next poll: push fresh
    // instance data (a changed snapshot re-renders the flow) with the live
    // row now present.
    fixtures.liveSessions = [{ connectionId: 'conn-1' }];
    fixtures.instances = { instances: [makeInstance('conn-1', 'MyMac (work)')] };
    await act(async () => {
      queryClient.setQueryData(INSTANCES_KEY, fixtures.instances);
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
    await waitFor(() => findByText(root, 'firstRunTour.cliSessionCreated').length > 0);
    expectNoText(root, 'common.refresh');
    expectNoText(root, 'common.loading');
    expect(countTyped(root, 'Skeleton')).toBe(0);
    const done = findButtonByLabel(root, 'common.done');
    if (!done) {
      throw new Error('Done button is missing');
    }
    expect((done.props as { disabled?: boolean }).disabled).toBe(false);
  });

  it('Done marks the tour done and dismisses without waiting for the flushed write', async () => {
    fixtures.history = { cliSessions: [{ cloud_agent_session_id: 'cas-1' }] };
    fixtures.instances = { instances: [makeInstance('conn-1', 'MyMac')] };
    // Done only unlocks on the real outcome: a live session on the instance.
    fixtures.liveSessions = [{ connectionId: 'conn-1' }];
    const { root } = await mountTour();
    await advanceToCli(root);
    routerMock.back.mockImplementation(() => {
      dismissalOrder.push('back');
    });

    await pressText(root, 'common.done');
    expect(markMock).toHaveBeenCalledWith('u1', 'done');
    // The mark is fired (its write forced) and the dismissal proceeds; the
    // gate's outcome latch, not the awaited flush, stops the re-show.
    expect(dismissalOrder).toEqual(['mark', 'back']);
  });

  it('Skip from the fork step marks skipped and dismisses', async () => {
    // This press lands within milliseconds of mount — the fastest decision
    // the flow will ever see, including the e2e login helper's automatic
    // prompt dismissal tapping 'Skip tour' seconds after a first-sign-in
    // auto-open. Every Skip records immediately (owner, 2026-09-08): a Skip
    // that did not record left the tour re-opening on the second sign-in,
    // failing 'second sign-in must not' (e1, 2026-09-08). First-sign-in
    // behavior is observed by the harness before the helper's dismissal
    // through the login hook, not by ignoring fast Skips here.
    const { root } = await mountTour();
    routerMock.back.mockImplementation(() => {
      dismissalOrder.push('back');
    });

    await pressText(root, 'firstRunTour.skipTour');
    expect(markMock).toHaveBeenCalledWith('u1', 'skipped');
    expect(dismissalOrder).toEqual(['mark', 'back']);
  });

  it('a Skip pressed in the same tick the tour mounts records skipped immediately', async () => {
    // The removed machine-eat grace ignored a Skip pressed within 5 s of an
    // auto-opened tour; no tour instance is too young to record its dismissal
    // (owner, 2026-09-08). The press below runs with no clock advance at all
    // — the same tick the modal mounted in — and the record plus the
    // dismissal must already have happened synchronously.
    const { root } = await mountTour();
    routerMock.back.mockImplementation(() => {
      dismissalOrder.push('back');
    });
    const skipPress = findPressable(root, 'firstRunTour.skipTour');

    act(() => {
      skipPress();
    });
    expect(markMock).toHaveBeenCalledWith('u1', 'skipped');
    expect(dismissalOrder).toEqual(['mark', 'back']);
  });

  it('Skip from a mid-tour step marks skipped and dismisses', async () => {
    const { root } = await mountTour();
    await advanceToCloud(root);
    routerMock.back.mockImplementation(() => {
      dismissalOrder.push('back');
    });

    await pressText(root, 'firstRunTour.skipTour');
    expect(markMock).toHaveBeenCalledWith('u1', 'skipped');
    expect(dismissalOrder).toEqual(['mark', 'back']);
  });

  it('Skip from the last step marks skipped and dismisses', async () => {
    fixtures.history = { cliSessions: [{ cloud_agent_session_id: 'cas-1' }] };
    const { root } = await mountTour();
    await advanceToCli(root);
    routerMock.back.mockImplementation(() => {
      dismissalOrder.push('back');
    });

    await pressText(root, 'firstRunTour.skipTour');
    expect(markMock).toHaveBeenCalledWith('u1', 'skipped');
    expect(dismissalOrder).toEqual(['mark', 'back']);
  });

  it('registers an always-on removal guard', async () => {
    await mountTour();
    expect(usePreventRemoveMock).toHaveBeenCalledTimes(1);
    expect(usePreventRemoveMock.mock.calls[0]?.[0]).toBe(true);
  });

  it('registers an Android hardware-back subscription while the tour is on screen', async () => {
    // e4 device failure (2026-09-08): with the predictive-back opt-in in the
    // manifest, RN 0.86 registers its dispatcher back-callback only when
    // device SDK AND targetSdk are >= 36, so on Android 13-15 the press never
    // reaches JS and the system finishes the activity to the launcher; the
    // app.config.ts opt-out (predictiveBackGestureEnabled: false) restores
    // the legacy path, and the tour must then own the press itself, while it
    // is focused, so the skip is recorded.
    await mountTour();
    expect(backHolder.addCount).toBe(1);
    expect(backHolder.handler).toBeDefined();
  });

  it('Android hardware back records skipped and dismisses the tour in-app', async () => {
    await mountTour();
    routerMock.back.mockImplementation(() => {
      dismissalOrder.push('back');
    });
    navigationDispatchMock.mockImplementation(() => {
      dismissalOrder.push('dispatch');
    });
    const handler = backHolder.handler;
    if (!handler) {
      throw new Error('the tour registered no hardware-back handler');
    }

    let consumed = false;
    act(() => {
      consumed = handler();
    });
    // Returning true stops the subscription chain before the container's
    // listener, so the press cannot reach the activity's exit path.
    expect(consumed).toBe(true);
    expect(markMock).toHaveBeenCalledWith('u1', 'skipped');
    // The dismissal is the Skip-button path: record, arm the guard bypass,
    // router.back() — whose removal the guard then replays once.
    expect(dismissalOrder).toEqual(['mark', 'back']);
    const action = { type: 'GO_BACK' };
    await act(async () => {
      preventRemoveHolder.callback?.({ data: { action } });
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
    expect(navigationDispatchMock).toHaveBeenCalledWith(action);
    expect(markMock).toHaveBeenCalledTimes(1);
  });

  it('a hardware Back pressed in the same tick the tour mounts records skipped immediately', async () => {
    // Same rule as the Skip button: the always-record BackHandler is live
    // from the first tick of the instance — no age threshold exists (owner,
    // 2026-09-08). The press below runs with no clock advance at all.
    await mountTour();
    routerMock.back.mockImplementation(() => {
      dismissalOrder.push('back');
    });
    const handler = backHolder.handler;
    if (!handler) {
      throw new Error('the tour registered no hardware-back handler');
    }

    let consumed = false;
    act(() => {
      consumed = handler();
    });
    expect(consumed).toBe(true);
    expect(markMock).toHaveBeenCalledWith('u1', 'skipped');
    expect(dismissalOrder).toEqual(['mark', 'back']);
  });

  it('a second hardware back before the removal lands replays the removal only once', async () => {
    await mountTour();
    navigationDispatchMock.mockImplementation(() => {
      dismissalOrder.push('dispatch');
    });
    const handler = backHolder.handler;
    if (!handler) {
      throw new Error('the tour registered no hardware-back handler');
    }

    const first = { type: 'GO_BACK' };
    const second = { type: 'GO_BACK' };
    await act(async () => {
      // First press: dismissWith records, arms the bypass, router.back();
      // the removal is intercepted and replayed once.
      handler();
      preventRemoveHolder.callback?.({ data: { action: first } });
      // The tour is still on screen while the replay settles: a repeat
      // press must not queue a second pop behind the modal.
      handler();
      preventRemoveHolder.callback?.({ data: { action: second } });
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
    expect(navigationDispatchMock).toHaveBeenCalledTimes(1);
    expect(navigationDispatchMock).toHaveBeenCalledWith(first);
  });

  it('the hardware-back subscription is removed when the tour leaves', async () => {
    // Focus-scoped: a route pushed above the tour (new-session) must get its
    // own back behavior back, not the tour's skip-and-dismiss.
    const result = await renderWithProviders(createElement(FirstRunTourFlow), {
      queryClient: seedQueryClient(),
    });
    expect(backHolder.addCount).toBe(1);
    result.unmount();
    expect(backHolder.removeCount).toBe(1);
    expect(backHolder.handler).toBeUndefined();
  });

  it('iOS registers no hardware-back subscription', async () => {
    fixtures.platformOS = 'ios';
    await mountTour();
    expect(backHolder.addCount).toBe(0);
  });

  it('a back-type removal reaching the guard from the fork step marks skipped, then replays the removal', async () => {
    await mountTour();
    navigationDispatchMock.mockImplementation(() => {
      dismissalOrder.push('dispatch');
    });

    const action = await triggerHardwareBack();
    expect(markMock).toHaveBeenCalledWith('u1', 'skipped');
    expect(navigationDispatchMock).toHaveBeenCalledWith(action);
    // The replay fires in the same tick as the record; the re-show loop is
    // stopped by the outcome latch, not by delaying the pop behind the write.
    expect(dismissalOrder).toEqual(['mark', 'dispatch']);
    // The guard replays the captured action; it must not call router.back
    // (the removal was already prevented and is being replayed).
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  it('a mid-tour back-type removal marks skipped and replays the removal', async () => {
    const { root } = await mountTour();
    await advanceToCloud(root);
    navigationDispatchMock.mockImplementation(() => {
      dismissalOrder.push('dispatch');
    });

    const action = await triggerHardwareBack();
    expect(markMock).toHaveBeenCalledWith('u1', 'skipped');
    expect(navigationDispatchMock).toHaveBeenCalledWith(action);
    expect(dismissalOrder).toEqual(['mark', 'dispatch']);
  });

  it('a back-type replay is not delayed by a slow decision write', async () => {
    // Live defect (2026-09-07): the guard awaited the flushed mark before
    // replaying, so a slow SQLCipher write held the prevented modal on screen
    // for 8.7 s after the person pressed back. The mark must be fired
    // fire-and-forget, with the replay dispatched in the same tick.
    fixtures.hangMark = true;
    await mountTour();
    navigationDispatchMock.mockImplementation(() => {
      dismissalOrder.push('dispatch');
    });

    const action = await triggerHardwareBack();
    expect(markMock).toHaveBeenCalledWith('u1', 'skipped');
    expect(navigationDispatchMock).toHaveBeenCalledWith(action);
    expect(dismissalOrder).toEqual(['mark', 'dispatch']);
  });

  it('a deep-link removal replays without recording a decision', async () => {
    // RESET/SET_NAVIGATION_STATE removals are programmatic navigation, not
    // the person leaving the tour (the e2e login verification deep-links to
    // the profile while the tour is up). The guard must replay it without
    // persisting 'skipped', so the gate can re-open the tour on the next
    // home arrival — a consumed skip is a decision nobody made.
    await mountTour();
    navigationDispatchMock.mockImplementation(() => {
      dismissalOrder.push('dispatch');
    });

    const action = { type: 'RESET' };
    await act(async () => {
      preventRemoveHolder.callback?.({ data: { action } });
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });

    expect(markMock).not.toHaveBeenCalled();
    expect(navigationDispatchMock).toHaveBeenCalledWith(action);
    expect(dismissalOrder).toEqual(['dispatch']);
  });

  it('a second back-type removal during the flush replays the removal only once', async () => {
    await mountTour();
    navigationDispatchMock.mockImplementation(() => {
      dismissalOrder.push('dispatch');
    });

    const first = { type: 'GO_BACK' };
    const second = { type: 'GO_BACK' };
    await act(async () => {
      preventRemoveHolder.callback?.({ data: { action: first } });
      // The screen is still on the stack while the mark flushes: a repeat
      // press must not queue a second pop behind the modal.
      preventRemoveHolder.callback?.({ data: { action: second } });
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });

    expect(markMock).toHaveBeenCalledTimes(1);
    expect(markMock).toHaveBeenCalledWith('u1', 'skipped');
    expect(navigationDispatchMock).toHaveBeenCalledTimes(1);
    expect(navigationDispatchMock).toHaveBeenCalledWith(first);
    expect(dismissalOrder).toEqual(['mark', 'dispatch']);
  });

  it('Skip tapped while a back-type flush is in flight dismisses with a single replay', async () => {
    const { root } = await mountTour();
    navigationDispatchMock.mockImplementation(() => {
      dismissalOrder.push('dispatch');
    });
    routerMock.back.mockImplementation(() => {
      dismissalOrder.push('back');
    });

    const skipPress = findPressable(root, 'firstRunTour.skipTour');
    const first = { type: 'GO_BACK' };
    const second = { type: 'GO_BACK' };
    await act(async () => {
      // Hardware back starts the flushed unhandled removal; the tour is
      // still interactive, so Skip can be pressed mid-flush.
      preventRemoveHolder.callback?.({ data: { action: first } });
      skipPress();
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
      // dismissWith armed the bypass and called router.back(): the
      // interception must not add a second replay.
      preventRemoveHolder.callback?.({ data: { action: second } });
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });

    // The in-flight removal owns the single pop; the armed bypass is
    // swallowed instead of replaying a second action.
    expect(navigationDispatchMock).toHaveBeenCalledTimes(1);
    expect(navigationDispatchMock).toHaveBeenCalledWith(first);
    expect(markMock).toHaveBeenCalledWith('u1', 'skipped');
  });

  it('Skip records the decision once and the guard then only replays the removal', async () => {
    const { root } = await mountTour();
    routerMock.back.mockImplementation(() => {
      dismissalOrder.push('back');
    });

    await pressText(root, 'firstRunTour.skipTour');
    expect(markMock).toHaveBeenCalledTimes(1);
    expect(markMock).toHaveBeenCalledWith('u1', 'skipped');

    // router.back() triggers the prevented removal: the armed guard must
    // replay the action without recording a second decision.
    const action = await triggerHardwareBack();
    expect(navigationDispatchMock).toHaveBeenCalledWith(action);
    expect(markMock).toHaveBeenCalledTimes(1);
  });

  it('a back-type removal without a userId still leaves the tour', async () => {
    fixtures.userId = undefined;
    await mountTour();

    const action = await triggerHardwareBack();
    expect(markMock).not.toHaveBeenCalled();
    expect(navigationDispatchMock).toHaveBeenCalledWith(action);
  });

  it('dismissal without a userId still leaves the tour', async () => {
    fixtures.userId = undefined;
    const { root } = await mountTour();

    await pressText(root, 'firstRunTour.skipTour');
    expect(markMock).not.toHaveBeenCalled();
    expect(routerMock.back).toHaveBeenCalled();
  });
});

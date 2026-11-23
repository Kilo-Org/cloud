import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@/test/render-with-providers';

// Static import: the route module is under test, and its `vi.mock`-ed
// dependencies register before this import resolves.
import TriggerDetailRoute from '@/app/(app)/(tabs)/(3_profile)/triggers/[trigger-id]';
import { TriggerCreateScreen } from '@/components/cloud-triggers/trigger-create-screen';

/**
 * The create hand-off retires the create screen from the detail's side: the
 * push-and-retire helper's own listener belongs to the create screen, which a
 * covered screen never runs, so without this side's judgment the form survives
 * beneath the detail and one Back lands on it.
 */

type Route = { key: string; name: string; params?: object };
type State = { routes: Route[]; index: number };

const resetMock = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());
const createMutation = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

type Nav = {
  state: State;
  /** Every live addListener registration, in registration order. */
  listeners: { event: string; listener: (event?: unknown) => void }[];
};

const nav = vi.hoisted<Nav>(() => ({
  state: { routes: [], index: 0 },
  listeners: [],
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock, back: vi.fn() }),
  usePreventRemove: (_enabled: boolean, _handler?: () => void) => undefined,
  useLocalSearchParams: () => ({ 'trigger-id': 'trigger-1', org: 'org-1' }),
  usePathname: () => '/(app)/(tabs)/(3_profile)/triggers/trigger-1',
  useNavigation: () => ({
    getState: () => nav.state,
    reset: resetMock,
    addListener: (event: string, listener: (event?: unknown) => void) => {
      nav.listeners.push({ event, listener });
      return () => {
        nav.listeners = nav.listeners.filter(registered => registered.listener !== listener);
      };
    },
  }),
}));

// The detail screen is not the subject: only the route's navigation effects are.
vi.mock('@/components/cloud-triggers/trigger-detail-screen', () => ({
  TriggerDetailScreen: () => null,
}));

// The create screen's own dependencies, the way its guard suite supplies them.
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    webhookTriggers: {
      create: { mutationOptions: () => ({}) },
      list: { pathFilter: () => ({ queryKey: ['webhookTriggers', 'list'] }) },
    },
  }),
}));

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<object>()),
  useMutation: () => createMutation,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  useWindowDimensions: () => ({ width: 402, height: 874, fontScale: 1 }),
  View: 'View',
  ScrollView: 'ScrollView',
}));

vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/cloud-triggers/trigger-form', () => ({
  TriggerForm: (props: Record<string, unknown>) => createElement('TriggerForm', props),
}));

const TABS = 'tabs';
const LIST = 'triggers/index';
const CREATE = 'triggers/new';
const DETAIL = 'triggers/[trigger-id]';

function setStack(routes: Route[], index: number) {
  nav.state = { routes, index };
}

/**
 * Fire one event type across the listeners the live renderers registered: the
 * way the native stack reports a transition end to the screens still mounted.
 * A screen the harness froze (unmounted, the covered create screen) cannot
 * emit — its listener left the registry with its unmount cleanup, which is the
 * device behaviour the suite pins.
 */
function fireNavigationEvent(event: string) {
  const listeners = nav.listeners.filter(registered => registered.event === event);
  act(() => {
    for (const { listener } of listeners) {
      listener();
    }
  });
}

function endTransition() {
  fireNavigationEvent('transitionEnd');
}

const r = (key: string, name: string, params?: object): Route => ({ key, name, params });

beforeEach(() => {
  resetMock.mockReset();
  pushMock.mockReset();
  replaceMock.mockReset();
  createMutation.mutateAsync.mockReset();
  nav.listeners = [];
});

describe('TriggerDetailRoute retire-covered-source', () => {
  it('retires the create screen from the transitionEnd listener, not only at mount', () => {
    // The stack before the push settles: the create screen focused, no detail
    // above it, so the mount-time judgment has no shape to remove — the reset
    // can only come from the listener.
    setStack([r(TABS, '(tabs)'), r('l', LIST), r('new', CREATE)], 2);
    act(() => {
      TestRenderer.create(createElement(TriggerDetailRoute));
    });
    expect(resetMock).not.toHaveBeenCalled();

    // The create hand-off's push commits: the form is covered, the detail
    // focused, the list beneath the form.
    setStack(
      [
        r(TABS, '(tabs)'),
        r('l', LIST),
        r('new', CREATE),
        r('d', DETAIL, { 'trigger-id': 'trigger-1', org: 'org-1' }),
      ],
      3
    );
    // The navigator reports the end of the push's transition.
    endTransition();

    expect(resetMock).toHaveBeenCalledTimes(1);
    const [nextState] = resetMock.mock.calls[0] as [State];
    // The form is gone and the focused route is still the detail.
    expect(nextState.routes.map(route => route.key)).toEqual([TABS, 'l', 'd']);
    expect(nextState.index).toBe(2);
  });

  it('keeps judging at mount when the push ended before the route mounted', () => {
    // The stack after the push settles, with the detail mounted on it: the
    // mount-time judgment already sees the shape and performs the reset.
    setStack(
      [
        r(TABS, '(tabs)'),
        r('l', LIST),
        r('new', CREATE),
        r('d', DETAIL, { 'trigger-id': 'trigger-1', org: 'org-1' }),
      ],
      3
    );

    act(() => {
      TestRenderer.create(createElement(TriggerDetailRoute));
    });

    expect(resetMock).toHaveBeenCalledTimes(1);
    const [nextState] = resetMock.mock.calls[0] as [State];
    expect(nextState.routes.map(route => route.key)).toEqual([TABS, 'l', 'd']);
    expect(nextState.index).toBe(2);
  });

  it('leaves a deep-linked detail with no form beneath it untouched', () => {
    setStack(
      [
        r(TABS, '(tabs)'),
        r('l', LIST),
        r('d', DETAIL, { 'trigger-id': 'trigger-1', org: 'org-1' }),
      ],
      2
    );

    act(() => {
      TestRenderer.create(createElement(TriggerDetailRoute));
    });

    endTransition();

    expect(resetMock).not.toHaveBeenCalled();
  });

  it('does not remove the list when the create screen never sat beneath', () => {
    // A guard handwriting: some navigation wedged a screen between the form
    // and the detail. The shape does not match, so nothing moves.
    setStack(
      [
        r(TABS, '(tabs)'),
        r('l', LIST),
        r('new', CREATE),
        r('wedge', 'agent-chat/session'),
        r('d', DETAIL, { 'trigger-id': 'trigger-1', org: 'org-1' }),
      ],
      4
    );

    act(() => {
      TestRenderer.create(createElement(TriggerDetailRoute));
    });

    endTransition();

    expect(resetMock).not.toHaveBeenCalled();
  });
});

describe('TriggerCreateScreen hand-off through the detail route', () => {
  /** Mount the create screen the way the create route does. */
  function mountCreateScreen() {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      ref.current = TestRenderer.create(createElement(TriggerCreateScreen));
    });
    if (!ref.current) {
      throw new Error('create screen did not render');
    }
    return Promise.resolve(ref.current);
  }

  /** Hand the form the draft change a field edit produces. */
  function editDraft(renderer: TestRenderer.ReactTestRenderer): void {
    const formProps = renderer.root.findByProps({ mode: 'create' }).props as {
      onDraftChange: (update: (current: Record<string, unknown>) => unknown) => void;
    };
    act(() => {
      formProps.onDraftChange(() => ({
        activation: 'webhook',
        cron: '',
        timezone: 'UTC',
        repository: 'owner/repo',
        agent: 'code',
        model: 'kilo-auto/efficient',
        variant: '',
        prompt: 'Describe this webhook request payload:\n\n{{body}}',
        environmentId: null,
        profileId: null,
        bodySchemaJson: '',
        autoCommit: false,
        condenseOnComplete: false,
        active: true,
        authEnabled: false,
        authHeader: '',
        authSecret: '',
        runAsCreator: false,
        name: 'trigger-new',
      }));
    });
  }

  /** Press the form's submit with the handler the latest render carries. */
  async function submitForm(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
    const submitProps = renderer.root.findByProps({ mode: 'create' }).props as {
      onSubmit: () => void;
    };
    await act(async () => {
      submitProps.onSubmit();
      await Promise.resolve();
    });
  }

  it('the create screen pushes the detail and the detail retires the form beneath it', async () => {
    createMutation.mutateAsync.mockResolvedValue({ triggerId: 'trigger-new' });
    // The hand-off's starting stack: the list beneath the focused create form.
    setStack([r(TABS, '(tabs)'), r('l', LIST), r('new', CREATE)], 2);
    const createRenderer = await mountCreateScreen();

    editDraft(createRenderer);
    await submitForm(createRenderer);

    // The guard's disarm render lands, then the leave dispatches the push from
    // a `setTimeout(0)` macrotask (`useMetadataLeaveGuard`); the guard suite's
    // own seam flushes it deterministically instead of trusting one `act` pass,
    // which a loaded CI shard does not always give the timer.
    await waitFor(() => pushMock.mock.calls.length === 1);
    expect(pushMock).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/triggers/trigger-new');

    // The navigator commits the push: the form is covered, the detail focused.
    // A native Stack unmounts (freezes) a covered screen — its own
    // `transitionEnd` listener then never fires, which is exactly the dropped
    // case this suite pins — so the create renderer goes away here too.
    act(() => {
      createRenderer.unmount();
    });
    setStack(
      [
        r(TABS, '(tabs)'),
        r('l', LIST),
        r('new', CREATE),
        r('d-new', DETAIL, { 'trigger-id': 'trigger-new', org: 'org-1' }),
      ],
      3
    );

    // The detail route mounts — the real route module — and receives the
    // push's transitionEnd.
    const detailRenderer = await Promise.resolve(
      act(() => TestRenderer.create(createElement(TriggerDetailRoute)))
    );
    endTransition();

    // The form is retired beneath the still-focused detail: one Back now
    // reaches the list.
    expect(resetMock).toHaveBeenCalledTimes(1);
    const [nextState] = resetMock.mock.calls[0] as [State];
    expect(nextState.routes.map(route => route.key)).toEqual([TABS, 'l', 'd-new']);
    expect(nextState.index).toBe(2);

    act(() => {
      detailRenderer.unmount();
    });
  });
});

/* eslint-disable max-lines -- the screen's guard cases and the routing-queue harness they drive read as one suite. */
/**
 * The New trigger screen's leave guard.
 *
 * A draft the reader typed must not vanish behind one Back press: the header
 * back arrow, Android Back and the back gesture all remove this route, so the
 * shared keep-editing gate (`useMetadataLeaveGuard`) covers all three through
 * its `isDirty` computation. A clean form leaves without asking, and a create
 * that succeeded leaves without asking about the draft it just saved.
 */

import { type Context, createElement, useContext, useMemo, useState } from 'react';

import {
  PendingIntentsContext,
  RoutingQueueApiContext,
  RoutingQueueProvider,
} from 'expo-router/build/global-state/routingQueueContext';
import {
  type QueuedRoutingIntent,
  type RoutingIntent,
} from 'expo-router/build/global-state/routingQueue';
import { NavigationContext as VendoredNavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { resetLeaveSettle } from '@/lib/navigation/leave-settle';
import { deviceTimeZone } from '@/lib/intl-cache';

import { TriggerCreateScreen } from './trigger-create-screen';

// The harness supplies only the surface the guard reads from navigation, so the
// context is read through the `unknown` shape the other focus suites use.
const NavigationContext = VendoredNavigationContext as Context<unknown>;

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  confirm: vi.fn(),
  repeat: vi.fn(),
  repeatSawEnabled: [] as boolean[],
  guard: {
    enabled: false as boolean,
    handler: undefined as
      | ((options: { data: { action: { type: string } }; repeat: () => void }) => void)
      | undefined,
  },
  createMutation: { mutateAsync: vi.fn(), isPending: false },
  queue: {
    enqueue: (_intent: RoutingIntent): void => undefined,
    dequeue: (_processed: QueuedRoutingIntent[]): void => undefined,
    queued: [] as QueuedRoutingIntent[],
    setFocused: (_focused: boolean): void => undefined,
  },
}));

vi.mock('expo-router', () => ({
  usePreventRemove: (
    enabled: boolean,
    handler: (options: { data: { action: { type: string } }; repeat: () => void }) => void
  ) => {
    h.guard.enabled = enabled;
    h.guard.handler = handler;
  },
  usePathname: () => '/(app)/(tabs)/(3_profile)/triggers/new',
  useNavigation: () => ({
    getState: () => ({
      index: 1,
      routes: [
        { key: 'tab', name: '(tabs)' },
        { key: 'new', name: 'triggers/new' },
      ],
    }),
    addListener: () => vi.fn(),
    isFocused: () => true,
  }),
  useRouter: () => ({ replace: h.replace, push: vi.fn(), back: vi.fn() }),
  useLocalSearchParams: () => ({}),
}));

// `route-focus.ts` reads the vendored focus context directly, so this mock puts
// the guard's focus read under this suite's own provider. Mocking the concrete
// module keeps a Node test off the navigation stack's build output.
//
// The routing queue is NOT mocked: expo-router's own `RoutingQueueProvider` is
// plain React state over an intent array, it imports no navigator, and it is
// what computes `NavigationPendingContext` as `isPending || queue.length > 0`.
// Mounting it means the pending value every case reads is produced by
// expo-router code from the queue the case itself drives.
vi.mock('expo-router/build/react-navigation/core/NavigationContext', async () => {
  const { createContext } = await import('react');
  return { NavigationContext: createContext<unknown>(undefined) };
});

vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace: h.replace }),
}));

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
  useMutation: () => h.createMutation,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm, dialog: null }),
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
vi.mock('./trigger-form', () => ({
  TriggerForm: (props: Record<string, unknown>) => createElement('TriggerForm', props),
}));

function discardRequest() {
  const request = h.confirm.mock.calls.at(-1)?.[0] as
    | { onConfirm?: () => void; onCancel?: () => void }
    | undefined;
  if (!request) {
    throw new Error('the discard confirmation was not raised');
  }
  return request;
}

/** Hand the guard the removal the navigator produces for a Back press. */
function pressBack() {
  const handler = h.guard.handler;
  if (!handler) {
    throw new Error('the guard did not register a removal handler');
  }
  act(() => {
    handler({
      data: { action: { type: 'GO_BACK' } },
      repeat: () => {
        h.repeatSawEnabled.push(h.guard.enabled);
        // The replay's `repeat` dispatches the action, and a dispatch only
        // enqueues an intent: this enters expo-router's own routing queue,
        // whose pending value is `isPending || queue.length > 0`, so the guard
        // reads pending from the provider's computation until a case drains it.
        h.queue.enqueue({ type: 'ACTION', payload: { action: { type: 'GO_BACK' } } });
        h.repeat();
      },
    });
  });
}

/** Apply the intents the queue holds, the way the root drainer does once a commit lands. */
function drainQueue() {
  act(() => {
    h.queue.dequeue(h.queue.queued);
  });
}

/**
 * The screen inside expo-router's own routing queue. `RoutingQueueProvider`
 * computes `NavigationPendingContext` as `isPending || queue.length > 0`, so the
 * pending transition every case reads is produced by expo-router code from the
 * queue the case itself drives: the replay enqueues, the case drains with a
 * `dequeue` of the intents it saw in `PendingIntentsContext`, and the focus read
 * answers from the navigation object's own `isFocused`. No case sets a flag.
 */
function GuardHarness() {
  return (
    <RoutingQueueProvider>
      <QueueDrivenScreen />
    </RoutingQueueProvider>
  );
}

function QueueDrivenScreen() {
  const api = useContext(RoutingQueueApiContext);
  const queued = useContext(PendingIntentsContext);
  const [focused, setFocused] = useState(true);
  if (api === undefined) {
    throw new Error('the routing queue provider did not supply its API');
  }
  h.queue.enqueue = api.enqueue;
  h.queue.dequeue = api.dequeue;
  h.queue.queued = queued;
  h.queue.setFocused = setFocused;
  const navigation = useMemo(
    () => ({ isFocused: () => focused, addListener: () => () => undefined }),
    [focused]
  );
  return (
    <NavigationContext.Provider value={navigation}>
      <TriggerCreateScreen />
    </NavigationContext.Provider>
  );
}

/** The draft the form reports, over the base the screen starts on. */
function editedDraft(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    activation: 'webhook',
    cron: '',
    timezone: deviceTimeZone(),
    repository: '',
    agent: 'code',
    model: '',
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
    ...overrides,
  };
}

/** Hand the form the draft change a field edit produces. */
function editDraft(
  renderer: {
    root: { findByProps: (props: Record<string, unknown>) => { props: Record<string, unknown> } };
  },
  overrides: Partial<Record<string, unknown>> = {}
): void {
  const formProps = renderer.root.findByProps({ mode: 'create' }).props as {
    onDraftChange: (next: Record<string, unknown>) => void;
  };
  act(() => {
    formProps.onDraftChange(editedDraft(overrides));
  });
}

/** Press the form's submit with the handler the latest render carries. */
async function submitForm(renderer: {
  root: { findByProps: (props: Record<string, unknown>) => { props: Record<string, unknown> } };
}): Promise<void> {
  const submitProps = renderer.root.findByProps({ mode: 'create' }).props as {
    onSubmit: () => void;
  };
  await act(async () => {
    submitProps.onSubmit();
    await Promise.resolve();
  });
}

describe('TriggerCreateScreen leave guard', () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetLeaveSettle();
    h.guard.enabled = false;
    h.guard.handler = undefined;
    h.repeatSawEnabled = [];
    // The harness cases hand these to the unmounted provider's API; a case that
    // mounts the screen without the queue must not dispatch into that stale one.
    h.queue.enqueue = () => undefined;
    h.queue.dequeue = () => undefined;
    h.queue.queued = [];
    h.queue.setFocused = () => undefined;
  });

  it('leaves a clean form without asking', async () => {
    await renderWithProviders(<TriggerCreateScreen />);

    expect(h.guard.enabled).toBe(false);
    pressBack();

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.repeat).toHaveBeenCalledTimes(1);
    expect(h.repeatSawEnabled).toEqual([false]);
  });

  it('asks before leaving a draft, and Keep editing keeps the guard on', async () => {
    const { renderer } = await renderWithProviders(<TriggerCreateScreen />);

    // The form is mocked; drive the draft change the form would report.
    editDraft(renderer, { name: 'probe-draft' });
    expect(h.guard.enabled).toBe(true);

    pressBack();

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: i18n.t('common.discardChangesTitle'),
      message: i18n.t('common.discardChangesMessage'),
      confirmLabel: i18n.t('common.discard'),
      cancelLabel: i18n.t('common.keepEditing'),
    });

    act(() => {
      discardRequest().onCancel?.();
    });

    expect(h.repeat).not.toHaveBeenCalled();
    expect(h.guard.enabled).toBe(true);
  });

  it('Discard replays the leave, then re-arms the surviving screen', async () => {
    const { renderer } = await renderWithProviders(<TriggerCreateScreen />);

    editDraft(renderer, { name: 'probe-draft' });
    pressBack();
    expect(h.repeat).not.toHaveBeenCalled();

    await act(async () => {
      discardRequest().onConfirm?.();
      await Promise.resolve();
    });

    expect(h.repeat).toHaveBeenCalledTimes(1);
    expect(h.repeatSawEnabled).toEqual([false]);
    // The replay went out disarmed; the effect takes the disarm back after it
    // dispatches, because a screen the navigator kept (its removal refused)
    // owes the next edit a prompt. The draft the form still holds keeps the
    // re-armed test true right away.
    await waitFor(() => h.guard.enabled);
    expect(h.guard.enabled).toBe(true);

    // The second Back runs on a re-armed guard whose draft still differs from
    // the baseline, so it raises the Discard prompt again: one call from the
    // first press, one from this one.
    pressBack();
    expect(h.confirm).toHaveBeenCalledTimes(2);
  });

  it("keeps the disarm through a granted pop's drain", async () => {
    const { renderer } = await renderWithProviders(<GuardHarness />);

    editDraft(renderer, { name: 'probe-draft' });
    pressBack();
    await act(async () => {
      discardRequest().onConfirm?.();
      await Promise.resolve();
    });

    // The replay went out disarmed, and its dispatch only queued the intent:
    // this pass cannot tell the pop was granted, so the latch holds while the
    // queue still carries the intent and the focus read still answers from the
    // state the dispatch was queued against. The queue is expo-router's own, and
    // its pending value is `isPending || queue.length > 0` — the intent the
    // replay enqueued is what keeps it pending here.
    expect(h.repeat).toHaveBeenCalledTimes(1);
    expect(h.queue.queued).toHaveLength(1);
    expect(h.guard.enabled).toBe(false);

    // The pop committed: the drained read sees this route unfocused, and a
    // granted pop never re-arms prevention on the route it carries away.
    act(() => {
      h.queue.setFocused(false);
    });
    drainQueue();
    expect(h.queue.queued).toHaveLength(0);
    expect(h.guard.enabled).toBe(false);
  });

  it('re-arms after a refused replay settles', async () => {
    const { renderer } = await renderWithProviders(<GuardHarness />);

    editDraft(renderer, { name: 'probe-draft' });
    pressBack();
    await act(async () => {
      discardRequest().onConfirm?.();
      await Promise.resolve();
    });
    expect(h.repeat).toHaveBeenCalledTimes(1);
    expect(h.queue.queued).toHaveLength(1);
    expect(h.guard.enabled).toBe(false);

    // The navigator refused the removal, so the screen survives the drain as
    // the focused route: the drained read is truthful and the guard re-arms.
    drainQueue();
    expect(h.queue.queued).toHaveLength(0);
    await waitFor(() => h.guard.enabled);
    expect(h.guard.enabled).toBe(true);

    pressBack();
    expect(h.confirm).toHaveBeenCalledTimes(2);
  });

  it('a create that succeeded leaves without asking about the saved draft', async () => {
    h.createMutation.mutateAsync.mockResolvedValue({ triggerId: 'trigger-new' });
    const { renderer } = await renderWithProviders(<TriggerCreateScreen />);

    editDraft(renderer, {
      name: 'trigger-new',
      repository: 'owner/repo',
      model: 'kilo-auto/efficient',
    });
    expect(h.guard.enabled).toBe(true);

    // The draft change re-rendered the form; its submit handler closes over
    // the new draft.
    await submitForm(renderer);

    expect(h.confirm).not.toHaveBeenCalled();
    // The leave waits one task behind the disarm render (`useMetadataLeaveGuard`),
    // so the replace lands in a macrotask the `Promise.resolve()` above does not
    // flush.
    await waitFor(() => h.replace.mock.calls.length === 1);
    expect(h.replace).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/triggers/trigger-new');
    await waitFor(() => !h.guard.enabled);
    expect(h.guard.enabled).toBe(false);
  });

  it('re-arms the guard when a created screen survives its hand-off', async () => {
    // The push-then-retire hand-off dropped the retire: the replace dispatched
    // but the navigator kept the create screen mounted and focused.
    h.createMutation.mutateAsync.mockResolvedValue({ triggerId: 'trigger-new' });
    const { renderer } = await renderWithProviders(<TriggerCreateScreen />);

    editDraft(renderer, {
      name: 'trigger-new',
      repository: 'owner/repo',
      model: 'kilo-auto/efficient',
    });
    await submitForm(renderer);
    await waitFor(() => h.replace.mock.calls.length === 1);
    await waitFor(() => !h.guard.enabled);

    // The create moved the dirty baseline to the saved draft, so the
    // re-armed test reads the trigger's saved values as saved: a Back on the
    // surviving screen leaves without a prompt about a draft that landed.
    expect(h.guard.enabled).toBe(false);
    pressBack();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.repeat).toHaveBeenCalledTimes(1);

    // A later edit on the surviving screen must be guarded again: the replay
    // effect took the disarm back, so the derived recompute runs.
    editDraft(renderer, { name: 'trigger-new-edited' });
    expect(h.guard.enabled).toBe(true);

    pressBack();
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });

  it('a surviving screen does not post a second trigger before an edit', async () => {
    // The hand-off dropped the retire: the screen still shows the created
    // trigger's values and its New button reads as valid. Submitting again
    // would post the trigger a second time, so the create stays done.
    h.createMutation.mutateAsync.mockResolvedValue({ triggerId: 'trigger-new' });
    const { renderer } = await renderWithProviders(<TriggerCreateScreen />);

    editDraft(renderer, {
      name: 'trigger-new',
      repository: 'owner/repo',
      model: 'kilo-auto/efficient',
    });
    await submitForm(renderer);
    await waitFor(() => h.replace.mock.calls.length === 1);

    await submitForm(renderer);

    expect(h.createMutation.mutateAsync).toHaveBeenCalledTimes(1);
    expect(h.replace).toHaveBeenCalledTimes(1);
    // The form paints the saved values and the New button is disabled: the
    // screen reflects that its draft is saved until an edit starts a new one.
    // `canSubmit` is the prop the form's New button reads, so it is asserted
    // beside the guard read.
    expect(renderer.root.findByProps({ mode: 'create' }).props.canSubmit).toBe(false);
    await waitFor(() => !h.guard.enabled);
  });

  it('an edit after a surviving create starts a new draft and re-enables the submit', async () => {
    h.createMutation.mutateAsync.mockResolvedValue({ triggerId: 'trigger-new' });
    const { renderer } = await renderWithProviders(<TriggerCreateScreen />);

    editDraft(renderer, {
      name: 'trigger-new',
      repository: 'owner/repo',
      model: 'kilo-auto/efficient',
    });
    await submitForm(renderer);
    await waitFor(() => h.replace.mock.calls.length === 1);

    editDraft(renderer, { name: 'trigger-next' });
    await submitForm(renderer);

    expect(h.createMutation.mutateAsync).toHaveBeenCalledTimes(2);
    expect(h.createMutation.mutateAsync.mock.calls[1]?.[0]).toMatchObject({
      triggerId: 'trigger-next',
    });
  });
});

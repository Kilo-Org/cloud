import { describe, expect, it, vi } from 'vitest';

import {
  APPROVE_TARGET,
  type GlanceableUserInteraction,
  handleApproveInteraction,
} from './approve-action';

type InteractionListener = (event: GlanceableUserInteraction) => void;

const mocks = vi.hoisted(() => ({
  listeners: [] as InteractionListener[],
  remove: vi.fn(),
}));

// The native surface is unreachable under vitest, so the expo-widgets
// subscription is the boundary under test: the module's handler is real.
vi.mock('expo-widgets', () => ({
  addUserInteractionListener: (listener: InteractionListener) => {
    mocks.listeners.push(listener);
    return { remove: mocks.remove };
  },
}));

/** The approve double: resolved, since nothing in the action reads the outcome. */
const approveThatResolves = () => vi.fn().mockResolvedValue(undefined);

/**
 * The native event's `source` is the ActivityKit instance id, not the Live
 * Activity's registration name: `WidgetLiveActivity.swift` renders the layout
 * with `name: context.activityID` and `DynamicView.swift` copies that name onto
 * the button's `source`. A fixed stand-in documents the shape the handler must
 * accept without pinning the test to a value the app can never see.
 */
const NATIVE_ACTIVITY_ID = '8E1D4C0A-3F6B-4A1E-9C4D-7B2F0A5E9D31';

function nativeEvent(): GlanceableUserInteraction {
  return { source: NATIVE_ACTIVITY_ID, target: APPROVE_TARGET };
}

/**
 * A fresh module graph per registration case: the listener and the callback it
 * routes to are module state, and `vi.resetModules()` is the only way back to
 * the unregistered state the app boots in.
 */
async function loadApproveAction() {
  vi.resetModules();
  mocks.listeners.length = 0;
  mocks.remove.mockClear();
  const approveActionModule = await import('./approve-action');
  return approveActionModule;
}

type ApproveActionModule = Awaited<ReturnType<typeof loadApproveAction>>;

function firstListener(): InteractionListener {
  const listener = mocks.listeners[0];
  if (listener === undefined) {
    throw new Error('the approve action did not subscribe');
  }
  return listener;
}

describe('handleApproveInteraction', () => {
  it('calls approve once for the Live Activity approve target', async () => {
    // The source the native intent reports is the activity id; the unique
    // `approve` target is what identifies this card's button.
    const approve = approveThatResolves();
    await handleApproveInteraction(nativeEvent(), approve);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('never calls approve for another target on the same activity', async () => {
    const approve = approveThatResolves();
    await handleApproveInteraction({ ...nativeEvent(), target: 'open' }, approve);
    expect(approve).not.toHaveBeenCalled();
  });

  it('swallows a rejected approval so the interaction never escapes', async () => {
    const approve = vi.fn().mockRejectedValue(new Error('The approval could not be sent'));
    await expect(handleApproveInteraction(nativeEvent(), approve)).resolves.toBeUndefined();
    expect(approve).toHaveBeenCalledTimes(1);
  });
});

describe('registerGlanceableApproveAction', () => {
  it('subscribes once and routes a matching event to approve', async () => {
    const mod = await loadApproveAction();
    const approve = approveThatResolves();
    const unsubscribe = mod.registerGlanceableApproveAction(approve);
    expect(mocks.listeners).toHaveLength(1);

    firstListener()(nativeEvent());
    await vi.waitFor(() => {
      expect(approve).toHaveBeenCalledTimes(1);
    });
    unsubscribe();
  });

  it('ignores a target the handler does not own', async () => {
    const mod = await loadApproveAction();
    const approve = approveThatResolves();
    const unsubscribe = mod.registerGlanceableApproveAction(approve);

    firstListener()({ source: NATIVE_ACTIVITY_ID, target: 'open' });
    firstListener()({ source: 'SomeOtherWidget', target: 'toggle' });
    await Promise.resolve();
    expect(approve).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('does not double-subscribe on a second registration', async () => {
    const mod: ApproveActionModule = await loadApproveAction();
    const first = approveThatResolves();
    const second = approveThatResolves();
    mod.registerGlanceableApproveAction(first);
    const unsubscribe = mod.registerGlanceableApproveAction(second);
    expect(mocks.listeners).toHaveLength(1);

    firstListener()(nativeEvent());
    await vi.waitFor(() => {
      expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
    });
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('removes the listener through the returned unsubscribe', async () => {
    const mod = await loadApproveAction();
    const unsubscribe = mod.registerGlanceableApproveAction(approveThatResolves());
    unsubscribe();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it('leaves a later registration alone when an earlier unsubscribe runs', async () => {
    const mod: ApproveActionModule = await loadApproveAction();
    const first = approveThatResolves();
    const second = approveThatResolves();
    const unsubscribeFirst = mod.registerGlanceableApproveAction(first);
    mod.registerGlanceableApproveAction(second);

    // The second registration replaced the callback and owns the listener. The
    // first unsubscribe must not remove it or clear what it no longer owns, or
    // Approve would be dead until the next app launch.
    unsubscribeFirst();

    expect(mocks.remove).not.toHaveBeenCalled();
    firstListener()(nativeEvent());
    await vi.waitFor(() => {
      expect(second).toHaveBeenCalledTimes(1);
    });
    expect(first).not.toHaveBeenCalled();
  });

  it('does not clear a registration that replaced it when unsubscribing twice', async () => {
    const mod: ApproveActionModule = await loadApproveAction();
    const first = approveThatResolves();
    const second = approveThatResolves();
    const unsubscribeFirst = mod.registerGlanceableApproveAction(first);
    mod.registerGlanceableApproveAction(second);

    unsubscribeFirst();
    unsubscribeFirst();

    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.listeners).toHaveLength(1);
  });
});

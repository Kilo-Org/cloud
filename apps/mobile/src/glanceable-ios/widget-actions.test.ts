/* eslint-disable max-lines -- one cohesive sweep + widget-layout suite sharing the expo-widgets/@expo/ui mock harness */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  GLANCEABLE_SNAPSHOT_EXPIRY_MS,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import {
  buildHomeWidgetPresentation,
  EMPTY_HOME_WIDGET_DETAILS,
  type HomeWidgetDetails,
} from '@kilocode/app-shared/home-widget';

import { setHomeWidgetDetails } from '@/lib/glanceable/home-widget-data';
import { _setLastGlanceableSnapshotForTests } from '@/lib/glanceable/persist';
import { getSurfaceExtras, setSurfaceExtras } from '@/lib/glanceable/surface-extras';

import { type UserInteractionEvent, type WidgetFamily } from 'expo-widgets';

import { activeAgentsWidgetLayout, WIDGET_NAME } from './active-agents-widget';
import {
  PENDING_ACTION_TTL_MS,
  pendingActionForEvent,
  pendingActionOf,
  registerWidgetActionHandling,
  runPendingWidgetActions,
} from './widget-actions';
import { buildGlanceableViewProps, type GlanceableWidgetProps } from './view-props';

// The widget surfaces are unreachable under vitest: the swift-ui primitives are
// recording stubs, react-native is stubbed, and expo-widgets' factories are
// stubs with a controllable timeline — so the sweep and the stringified layout
// are the real logic under test.
const widgetState = vi.hoisted(() => ({
  timeline: [] as { date: Date; props: Record<string, unknown> }[],
  snapshots: [] as unknown[],
  listeners: [] as ((event: { source: string; target: string; timestamp: number }) => void)[],
  removals: 0,
  /**
   * When set, the next timeline read resolves only once it is released,
   * modelling a native read still in flight when the running pass ends.
   */
  timelineReadGate: null as Promise<unknown> | null,
}));

/** A swift-ui primitive stand-in: the kind tag rides on the function itself. */
function mockComponent(kind: string) {
  const fn = (props: Record<string, unknown>) => ({ kind, props });
  (fn as unknown as { kind: string }).kind = kind;
  return fn;
}

/** A recording swift-ui modifier stub. */
function mockModifier(name: string) {
  return (args?: unknown) => ({ $type: name, args });
}

vi.mock('expo-widgets', () => ({
  widgetsDirectory: 'file:///app-group/ExpoWidgets/',
  createWidget: () => ({
    updateSnapshot: (props: Record<string, unknown>) => {
      widgetState.snapshots.push(props);
      widgetState.timeline = [{ date: new Date(), props }];
    },
    updateTimeline: (entries: { date: Date; props: Record<string, unknown> }[]) => {
      widgetState.timeline = entries;
    },
    getTimeline: async () => {
      // The read answers with the timeline as of the read, never with the
      // writes that land while a held read waits.
      const timeline = widgetState.timeline;
      const gate = widgetState.timelineReadGate;
      if (gate !== null) {
        widgetState.timelineReadGate = null;
        await gate;
      }
      return timeline;
    },
    reload: () => undefined,
  }),
  addUserInteractionListener: (
    listener: (event: { source: string; target: string; timestamp: number }) => void
  ) => {
    widgetState.listeners.push(listener);
    return {
      remove: () => {
        widgetState.removals += 1;
      },
    };
  },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  Image: () => null,
  Linking: { openURL: mocks.linkingOpenURL },
}));

vi.mock('@expo/ui/swift-ui', () => ({
  Button: mockComponent('Button'),
  HStack: mockComponent('HStack'),
  Image: mockComponent('Image'),
  Spacer: mockComponent('Spacer'),
  Text: mockComponent('Text'),
  VStack: mockComponent('VStack'),
}));

vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityElement: mockModifier('accessibilityElement'),
  accessibilityLabel: mockModifier('accessibilityLabel'),
  allowsTightening: mockModifier('allowsTightening'),
  buttonStyle: mockModifier('buttonStyle'),
  containerBackground: mockModifier('containerBackground'),
  controlSize: mockModifier('controlSize'),
  cornerRadius: mockModifier('cornerRadius'),
  environment: mockModifier('environment'),
  font: mockModifier('font'),
  foregroundStyle: mockModifier('foregroundStyle'),
  frame: mockModifier('frame'),
  layoutPriority: mockModifier('layoutPriority'),
  lineLimit: mockModifier('lineLimit'),
  minimumScaleFactor: mockModifier('minimumScaleFactor'),
  monospacedDigit: mockModifier('monospacedDigit'),
  multilineTextAlignment: mockModifier('multilineTextAlignment'),
  resizable: mockModifier('resizable'),
  widgetURL: mockModifier('widgetURL'),
}));

const mocks = vi.hoisted(() => ({
  runWidgetApprove: vi.fn<() => Promise<{ kind: string }>>(),
  linkingOpenURL: vi.fn<() => Promise<void>>(),
  lastSnapshot: null as GlanceableAgentsSnapshot | null,
}));

vi.mock('@/lib/glanceable/widget-actions', () => ({
  runWidgetApprove: mocks.runWidgetApprove,
}));
vi.mock('@/lib/glanceable/persist', () => ({
  getLastGlanceableSnapshot: () => mocks.lastSnapshot,
  _resetGlanceablePersistForTests: () => {
    mocks.lastSnapshot = null;
  },
  _setLastGlanceableSnapshotForTests: (snapshot: GlanceableAgentsSnapshot | null) => {
    mocks.lastSnapshot = snapshot;
  },
}));
vi.mock('@/i18n', () => ({ i18n: { on: vi.fn(), t: (key: string) => key } }));

const NOW = 1_750_000_000_000;

function snapshotFor(sessions: { status: string }[], now = NOW): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now,
  });
}

const SCHEDULED_WAKE = '2026-09-24T09:00:00.000Z';

// ── mock-element tree helpers, shared with the render suite ─────────────────

type MockElement = { kind: string; props: Record<string, unknown> };

function collect(node: unknown): MockElement[] {
  if (node == null || typeof node !== 'object' || Array.isArray(node)) {
    return Array.isArray(node) ? node.flatMap(item => collect(item)) : [];
  }
  const kind = (node as { type?: { kind?: string } }).type?.kind;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (kind === undefined || props === undefined) {
    return [];
  }
  return [{ kind, props }, ...collect(props.children)];
}

function collectText(node: unknown): string[] {
  return collect(node)
    .filter(element => element.kind === 'Text' && typeof element.props.children === 'string')
    .map(element => element.props.children as string);
}

function collectOfKind(node: unknown, kind: string): MockElement[] {
  return collect(node).filter(element => element.kind === kind);
}

/** Every `widgetURL` modifier argument anywhere in the tree. */
function widgetURLs(node: unknown): unknown[] {
  return collect(node).flatMap(element => {
    const modifiers = element.props.modifiers;
    if (!Array.isArray(modifiers)) {
      return [];
    }
    return modifiers
      .filter((modifier: { $type?: string }) => modifier.$type === 'widgetURL')
      .map((modifier: { args?: unknown }) => modifier.args);
  });
}

function pressButton(
  tree: unknown,
  patch: { pendingAction: string; pendingApprovalKey?: string }
): MockElement | undefined {
  return collect(tree).find(element => {
    if (element.kind !== 'Button' || typeof element.props.onPress !== 'function') {
      return false;
    }
    const pressed = (element.props.onPress as () => Record<string, unknown>)();
    return (
      pressed.pendingAction === patch.pendingAction &&
      (patch.pendingApprovalKey === undefined ||
        pressed.pendingApprovalKey === patch.pendingApprovalKey)
    );
  });
}

const APPROVAL_KEY = 'a'.repeat(64);
const APPROVABLE: HomeWidgetDetails = { ...EMPTY_HOME_WIDGET_DETAILS, approvalKey: APPROVAL_KEY };

// ── marker mapping ──────────────────────────────────────────────────────────

describe('pendingActionOf', () => {
  it('reads the two press markers', () => {
    expect(pendingActionOf({ pendingAction: 'approve' })).toBe('approve');
    expect(pendingActionOf({ pendingAction: 'new-agent' })).toBe('new-agent');
  });

  it('reads nothing from props without a usable marker', () => {
    expect(pendingActionOf({})).toBeNull();
    // The marker comparison whitelists the two actions: a props object with an
    // absent or foreign marker names no action.
    expect(pendingActionOf({ pendingAction: undefined })).toBeNull();
    expect(pendingActionOf(null)).toBeNull();
    expect(pendingActionOf(undefined)).toBeNull();
  });

  it('keeps a carried marker inside the TTL and refuses one past it', () => {
    // The first rebuild records the press; a marker read straight after the
    // press carries no time yet and is never refused for age.
    expect(pendingActionOf({ pendingAction: 'new-agent' }, NOW)).toBe('new-agent');
    expect(
      pendingActionOf(
        { pendingAction: 'approve', pendingActionAt: NOW - PENDING_ACTION_TTL_MS },
        NOW
      )
    ).toBe('approve');
    expect(
      pendingActionOf(
        { pendingAction: 'approve', pendingActionAt: NOW - PENDING_ACTION_TTL_MS - 1 },
        NOW
      )
    ).toBeNull();
  });
});

describe('pendingActionForEvent', () => {
  const event = (): UserInteractionEvent => ({
    source: WIDGET_NAME,
    target: '__expo_widgets_target_0',
    timestamp: NOW,
    type: 'ExpoWidgetsUserInteraction',
  });

  it('maps the pressed entry through its pendingAction marker', () => {
    expect(
      pendingActionForEvent(event(), [{ props: { primaryCount: 1, pendingAction: 'approve' } }])
    ).toBe('approve');
  });

  it('ignores another widget kind or Live Activity source', () => {
    expect(
      pendingActionForEvent({ ...event(), source: 'ActiveAgentsLiveActivity' }, [
        { props: { pendingAction: 'approve' } },
      ])
    ).toBeNull();
  });

  it('maps nothing when no entry still carries a marker', () => {
    expect(pendingActionForEvent(event(), [{ props: { primaryCount: 1 } }])).toBeNull();
    expect(pendingActionForEvent(event(), [])).toBeNull();
  });

  it('ignores a carried marker past its TTL', () => {
    expect(
      pendingActionForEvent(event(), [
        {
          props: {
            pendingAction: 'new-agent',
            pendingActionAt: Date.now() - PENDING_ACTION_TTL_MS - 1,
          },
        },
      ])
    ).toBeNull();
  });
});

// ── the sweep ───────────────────────────────────────────────────────────────

describe('runPendingWidgetActions', () => {
  beforeEach(() => {
    widgetState.timeline = [];
    widgetState.snapshots = [];
    widgetState.listeners = [];
    widgetState.removals = 0;
    widgetState.timelineReadGate = null;
    mocks.runWidgetApprove.mockReset();
    mocks.linkingOpenURL.mockReset();
    mocks.lastSnapshot = null;
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
  });

  afterEach(() => {
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
  });

  it('runs the pressed action after clearing the marker from the stored timeline', async () => {
    widgetState.timeline = [
      {
        date: new Date(1),
        props: { primaryCount: 1, pendingAction: 'approve' },
      },
    ];
    // Hold the action in flight so the test can inspect the stored timeline
    // while the action is running.
    const gate = Promise.withResolvers<{ kind: string }>();
    mocks.runWidgetApprove.mockImplementation(async () => {
      await gate.promise;
      return { kind: 'approved' };
    });
    const sweep = runPendingWidgetActions();

    // The marker was already gone from the stored timeline while the action
    // was still running: a crash mid-action reads as a dropped press, never a
    // repeated one.
    await vi.waitFor(() => {
      expect(widgetState.timeline[0]?.props).not.toHaveProperty('pendingAction');
    });
    gate.resolve({ kind: 'approved' });
    await sweep;

    expect(mocks.runWidgetApprove).toHaveBeenCalledTimes(1);
    expect(widgetState.timeline[0]?.props).toMatchObject({ primaryCount: 1 });
  });

  it('strips the marker only from pressed entries and keeps every frame', async () => {
    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'approve' } },
      { date: new Date(2), props: { statusLine: 'Updates delayed' } },
    ];
    mocks.runWidgetApprove.mockResolvedValue({ kind: 'approved' });

    await runPendingWidgetActions();

    expect(widgetState.timeline).toEqual([
      { date: new Date(1), props: {} },
      { date: new Date(2), props: { statusLine: 'Updates delayed' } },
    ]);
    expect(mocks.runWidgetApprove).toHaveBeenCalledTimes(1);
  });

  it('drops a carried press older than the TTL without running it', async () => {
    widgetState.timeline = [
      {
        date: new Date(1),
        props: {
          pendingAction: 'new-agent',
          pendingActionAt: Date.now() - PENDING_ACTION_TTL_MS - 1,
        },
      },
    ];

    await runPendingWidgetActions();

    // A press from a previous session is never answered late, and the stale
    // marker is cleared so it cannot linger in the stored timeline.
    expect(mocks.linkingOpenURL).not.toHaveBeenCalled();
    expect(widgetState.timeline).toEqual([{ date: new Date(1), props: {} }]);
  });

  it('runs a carried press inside the TTL and clears its recorded time', async () => {
    widgetState.timeline = [
      {
        date: new Date(1),
        props: { pendingAction: 'new-agent', pendingActionAt: Date.now() - 1000 },
      },
    ];

    await runPendingWidgetActions();

    expect(mocks.linkingOpenURL).toHaveBeenCalledWith('kiloapp:///cloud/sessions/new');
    // Stripping the recorded time is the explicit clear: the extension finds no
    // marker left to carry forward, so the press cannot run twice.
    expect(widgetState.timeline).toEqual([{ date: new Date(1), props: {} }]);
  });

  it('never runs the same press twice on a second sweep', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    mocks.runWidgetApprove.mockResolvedValue({ kind: 'approved' });

    await runPendingWidgetActions();
    await runPendingWidgetActions();

    expect(mocks.runWidgetApprove).toHaveBeenCalledTimes(1);
  });

  it('never runs the same press twice on overlapping sweeps', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    const gate = Promise.withResolvers<{ kind: string }>();
    mocks.runWidgetApprove.mockImplementation(async () => {
      await gate.promise;
      return { kind: 'approved' };
    });
    const first = runPendingWidgetActions();
    const second = runPendingWidgetActions();
    gate.resolve({ kind: 'approved' });
    await Promise.all([first, second]);

    expect(mocks.runWidgetApprove).toHaveBeenCalledTimes(1);
  });

  it('answers a press that lands while a sweep is running instead of dropping it', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    const gate = Promise.withResolvers<{ kind: string }>();
    mocks.runWidgetApprove.mockImplementation(async () => {
      await gate.promise;
      return { kind: 'approved' };
    });
    const sweep = runPendingWidgetActions();
    await vi.waitFor(() => {
      expect(mocks.runWidgetApprove).toHaveBeenCalledTimes(1);
    });

    // The second press lands mid-sweep: the intent patched its marker into the
    // stored timeline and the live listener delivered the event while the first
    // action was still in flight. The running sweep owes it a pass, or the tap
    // would only be answered at the next launch or foreground.
    widgetState.timeline = [{ date: new Date(2), props: { pendingAction: 'new-agent' } }];
    const live = runPendingWidgetActions({ source: WIDGET_NAME });
    gate.resolve({ kind: 'approved' });
    await Promise.all([sweep, live]);

    expect(mocks.runWidgetApprove).toHaveBeenCalledTimes(1);
    expect(mocks.linkingOpenURL).toHaveBeenCalledWith('kiloapp:///cloud/sessions/new');
    // The follow-up pass cleared the marker it ran, so a later sweep cannot
    // repeat the press it already answered.
    expect(widgetState.timeline[0]?.props).not.toHaveProperty('pendingAction');
    await runPendingWidgetActions();
    expect(mocks.linkingOpenURL).toHaveBeenCalledTimes(1);
  });

  it("answers a press whose marker the running action's republish erased", async () => {
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    const gate = Promise.withResolvers<{ kind: string }>();
    mocks.runWidgetApprove.mockImplementation(async () => {
      await gate.promise;
      // The answered approve republishes the tray: the sink builds fresh props
      // from the snapshot and writes the whole timeline, which is what takes
      // the mid-sweep press's marker with it.
      widgetState.timeline = [{ date: new Date(3), props: { primaryCount: 1 } }];
      return { kind: 'approved' };
    });
    const sweep = runPendingWidgetActions();
    await vi.waitFor(() => {
      expect(mocks.runWidgetApprove).toHaveBeenCalledTimes(1);
    });

    // The press lands while the first action runs, so the live listener reads
    // its marker out of the stored timeline at delivery — the last moment the
    // marker exists, because the republish replaces the whole timeline.
    widgetState.timeline = [{ date: new Date(2), props: { pendingAction: 'new-agent' } }];
    const live = runPendingWidgetActions({ source: WIDGET_NAME });
    // Wait for the delivery read before the republish lands: the press is held
    // as an action, not as a marker a later pass could re-read.
    await live;
    gate.resolve({ kind: 'approved' });
    await sweep;

    // The follow-up pass answers the held press. Re-reading the timeline after
    // the republish finds no marker, which is the drop this covers.
    expect(mocks.runWidgetApprove).toHaveBeenCalledTimes(1);
    expect(mocks.linkingOpenURL).toHaveBeenCalledWith('kiloapp:///cloud/sessions/new');
  });

  it('waits for the held press read before the sweep decides to stop', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    const gate = Promise.withResolvers<{ kind: string }>();
    mocks.runWidgetApprove.mockImplementation(async () => {
      await gate.promise;
      // The answered approve republishes the tray, which takes the mid-sweep
      // press's marker with it.
      widgetState.timeline = [{ date: new Date(3), props: { primaryCount: 1 } }];
      return { kind: 'approved' };
    });
    const sweep = runPendingWidgetActions();
    await vi.waitFor(() => {
      expect(mocks.runWidgetApprove).toHaveBeenCalledTimes(1);
    });

    // The second press lands mid-sweep and its delivery read is still in
    // flight when the first action ends. A queued pass that runs before that
    // read settles reads no marker and holds no press, so the tap would only
    // be answered at the next launch or foreground.
    widgetState.timeline = [{ date: new Date(2), props: { pendingAction: 'new-agent' } }];
    const heldRead = Promise.withResolvers<null>();
    widgetState.timelineReadGate = heldRead.promise;
    const live = runPendingWidgetActions({ source: WIDGET_NAME });

    gate.resolve({ kind: 'approved' });
    // Let the running sweep run out its queued pass before the read lands: the
    // drop this covers is that pass deciding to stop while the read is out.
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });
    heldRead.resolve(null);
    await Promise.all([sweep, live]);

    expect(mocks.runWidgetApprove).toHaveBeenCalledTimes(1);
    expect(mocks.linkingOpenURL).toHaveBeenCalledWith('kiloapp:///cloud/sessions/new');
  });

  it('maps a live interaction event through the marker and runs it once', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    mocks.runWidgetApprove.mockResolvedValue({ kind: 'approved' });
    registerWidgetActionHandling();
    // The launch sweep already picked the cold-start press up.
    await vi.waitFor(() => {
      expect(mocks.runWidgetApprove).toHaveBeenCalledTimes(1);
    });

    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    widgetState.listeners[0]?.({
      source: WIDGET_NAME,
      target: '__expo_widgets_target_0',
      timestamp: NOW,
    });
    await vi.waitFor(() => {
      expect(mocks.runWidgetApprove).toHaveBeenCalledTimes(2);
    });

    // Another widget kind's press owns no marker here, and this sweep must not
    // run this widget's marker on its behalf.
    widgetState.listeners[0]?.({
      source: 'ActiveAgentsLiveActivity',
      target: '__expo_widgets_target_0',
      timestamp: NOW,
    });
    expect(mocks.runWidgetApprove).toHaveBeenCalledTimes(2);
  });

  it("pushes the couldn't-approve feedback and fresh props when the approve fails", async () => {
    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'approve', pendingApprovalKey: APPROVAL_KEY } },
    ];
    mocks.runWidgetApprove.mockResolvedValue({ kind: 'failed' });
    _setLastGlanceableSnapshotForTests(snapshotFor([{ status: 'permission' }]));
    setHomeWidgetDetails(APPROVABLE);

    await runPendingWidgetActions();
    setHomeWidgetDetails(EMPTY_HOME_WIDGET_DETAILS);

    expect(mocks.runWidgetApprove).toHaveBeenCalledExactlyOnceWith(APPROVAL_KEY);

    expect(getSurfaceExtras().actionFeedback).toBe('couldNotApprove');
    expect(widgetState.snapshots).toHaveLength(1);
    expect(widgetState.snapshots[0]).toMatchObject({
      newestTitle: 'glanceable.couldNotApprove',
      // Approve is still available: the call failed, not the work.
      actions: { approve: true, newAgent: true },
    });
  });

  it('keeps the delayed and expiry frames on the failure republish', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    mocks.runWidgetApprove.mockResolvedValue({ kind: 'failed' });
    // Built against the wall clock, unlike this suite's fixed `NOW` snapshots:
    // the two trailing frames have to still be ahead of `now` to be written.
    const snapshot = snapshotFor([{ status: 'permission' }], Date.now());
    _setLastGlanceableSnapshotForTests(snapshot);

    await runPendingWidgetActions();

    // The failure republish replaces the timeline, so it owes WidgetKit the
    // same three frames the sink writes: a single frame would leave a widget
    // nothing refreshes claiming the failure line as current past `expiresAt`.
    expect(widgetState.timeline).toHaveLength(3);
    expect(widgetState.timeline[0]?.props.newestTitle).toBe('glanceable.couldNotApprove');
    expect(widgetState.timeline[1]?.props.statusLine).toBe('glanceable.stale');
    expect(widgetState.timeline[2]?.date.getTime()).toBe(Date.parse(snapshot.expiresAt));
    expect(widgetState.timeline[2]?.props).toMatchObject({ statusLine: 'glanceable.expired' });
  });

  it('writes one frame when the last snapshot already lapsed', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    mocks.runWidgetApprove.mockResolvedValue({ kind: 'failed' });
    // A snapshot that lapsed while the app was away: both trailing frames would
    // land behind the current one, and WidgetKit never rewinds to an entry it
    // has already passed, so the failure line keeps the timeline to itself.
    _setLastGlanceableSnapshotForTests(
      snapshotFor([{ status: 'permission' }], Date.now() - GLANCEABLE_SNAPSHOT_EXPIRY_MS - 60_000)
    );

    await runPendingWidgetActions();

    expect(widgetState.timeline).toHaveLength(1);
    expect(widgetState.timeline[0]?.props.newestTitle).toBe('glanceable.couldNotApprove');
  });

  it('clears the previous failure line before a retried approve runs', async () => {
    // The first press failed and left its line owning the reserved slot.
    setSurfaceExtras({
      newestSessionTitle: 'Fix the flaky test',
      actionFeedback: 'couldNotApprove',
    });
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    let feedbackDuringRun: string | null = 'not captured';
    let newestDuringRun: string | null = 'not captured';
    const gate = Promise.withResolvers<{ kind: string }>();
    mocks.runWidgetApprove.mockImplementation(async () => {
      // A success republishes the tray from inside the action, so the props
      // must already be free of the stale failure line at this moment.
      feedbackDuringRun = getSurfaceExtras().actionFeedback;
      newestDuringRun = buildGlanceableViewProps(
        snapshotFor([{ status: 'busy' }]),
        {},
        key => key
      ).newestTitle;
      await gate.promise;
      return { kind: 'approved' };
    });

    const sweep = runPendingWidgetActions();
    gate.resolve({ kind: 'approved' });
    await sweep;

    // Without the up-front clear the widget would answer a successful
    // approval with "Could not approve" and the newest-session line would
    // never come back.
    expect(feedbackDuringRun).toBeNull();
    expect(newestDuringRun).toBe('glanceable.newestSession');
    expect(getSurfaceExtras().actionFeedback).toBeNull();
  });

  it('opens the new-session screen for a New agent press without running Approve', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'new-agent' } }];
    _setLastGlanceableSnapshotForTests(snapshotFor([{ status: 'idle' }]));

    await runPendingWidgetActions();

    // Starting an agent needs the composer, so the press only lands on the
    // new-session screen: nothing runs in place and the widget is not redrawn.
    expect(mocks.linkingOpenURL).toHaveBeenCalledTimes(1);
    expect(mocks.linkingOpenURL).toHaveBeenCalledWith('kiloapp:///cloud/sessions/new');
    expect(mocks.runWidgetApprove).not.toHaveBeenCalled();
    expect(widgetState.snapshots).toEqual([]);
    expect(widgetState.timeline).toEqual([{ date: new Date(1), props: {} }]);
  });

  it('hands an approve with nothing to act on to the agents list', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    mocks.runWidgetApprove.mockResolvedValue({ kind: 'none' });

    await runPendingWidgetActions();

    expect(mocks.linkingOpenURL).toHaveBeenCalledWith('kiloapp:///cloud/sessions');
  });

  it('hands a question-waiting approve to the app instead of inventing an answer', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    mocks.runWidgetApprove.mockResolvedValue({ kind: 'no-permission' });

    await runPendingWidgetActions();

    expect(mocks.linkingOpenURL).toHaveBeenCalledWith('kiloapp:///cloud/sessions');
  });

  it('keeps a failed press on the widget without opening the app', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    mocks.runWidgetApprove.mockResolvedValue({ kind: 'failed' });

    await runPendingWidgetActions();

    expect(mocks.linkingOpenURL).not.toHaveBeenCalled();
  });

  it('leaves the answering to the republishing sink on a successful action', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    mocks.runWidgetApprove.mockResolvedValue({ kind: 'approved' });
    _setLastGlanceableSnapshotForTests(snapshotFor([{ status: 'busy' }]));

    await runPendingWidgetActions();

    expect(widgetState.snapshots).toEqual([]);
    expect(getSurfaceExtras().actionFeedback).toBeNull();
  });

  it('sweeps nothing when no entry carries a marker', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { primaryCount: 1 } }];

    await runPendingWidgetActions();

    expect(mocks.runWidgetApprove).not.toHaveBeenCalled();
    expect(widgetState.timeline).toEqual([{ date: new Date(1), props: { primaryCount: 1 } }]);
  });

  it('sweeps a cold-start press without a snapshot to rebuild from', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    mocks.runWidgetApprove.mockResolvedValue({ kind: 'none' });

    await runPendingWidgetActions();

    // The marker is still cleared in place, so the widget stops claiming the
    // press even though no snapshot exists to rebuild full props from.
    expect(widgetState.timeline[0]?.props).toEqual({});
  });
});

// ── the live subscription ───────────────────────────────────────────────────

describe('registerWidgetActionHandling', () => {
  /**
   * The listener and its ownership are module state, so a fresh module graph is
   * the only way back to the state the app boots in — the same reset the
   * sibling `approve-action.test.ts` uses for its registration.
   */
  async function loadWidgetActions() {
    vi.resetModules();
    widgetState.timeline = [];
    widgetState.snapshots = [];
    widgetState.listeners = [];
    widgetState.removals = 0;
    widgetState.timelineReadGate = null;
    mocks.runWidgetApprove.mockReset();
    mocks.lastSnapshot = null;
    const widgetActions = await import('./widget-actions');
    return widgetActions;
  }

  it('subscribes once and removes the listener through the returned unsubscribe', async () => {
    const mod = await loadWidgetActions();
    mod.registerWidgetActionHandling();
    const unsubscribe = mod.registerWidgetActionHandling();

    // Two registrations must not install two listeners: each sweep would race
    // the same markers, and the second could answer a press the first is
    // already running.
    expect(widgetState.listeners).toHaveLength(1);

    unsubscribe();
    expect(widgetState.removals).toBe(1);
  });

  it('leaves a later registration alone when an earlier unsubscribe runs', async () => {
    const mod = await loadWidgetActions();
    const unsubscribeFirst = mod.registerWidgetActionHandling();
    mod.registerWidgetActionHandling();

    // The second registration owns the listener now; the first's unsubscribe
    // must not remove it, or widget presses would be dead until the next launch.
    unsubscribeFirst();
    expect(widgetState.removals).toBe(0);
    expect(widgetState.listeners).toHaveLength(1);
  });
});

// ── the stringified layout ──────────────────────────────────────────────────

function renderWidget(props: GlanceableWidgetProps, family: WidgetFamily): MockElement {
  return activeAgentsWidgetLayout(props, {
    widgetFamily: family,
    date: new Date(0),
    configuration: undefined,
  }) as unknown as MockElement;
}

const HOME_FAMILIES: WidgetFamily[] = ['systemSmall', 'systemMedium', 'systemLarge'];
const ACCESSORY_FAMILIES: WidgetFamily[] = [
  'accessoryCircular',
  'accessoryInline',
  'accessoryRectangular',
];

function homeProps(
  sessions: Parameters<typeof buildGlanceableSnapshot>[0]['sessions'],
  details: HomeWidgetDetails = EMPTY_HOME_WIDGET_DETAILS,
  now = NOW
): GlanceableWidgetProps {
  const snapshot = buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
  });
  return buildGlanceableViewProps(snapshot, {}, key => key, { snapshot, details }, now);
}

describe('activeAgentsWidgetLayout', () => {
  it('keeps accessory families privacy-minimal despite Home titles and actions', () => {
    const props = homeProps([{ status: 'permission' }], {
      approvalKey: APPROVAL_KEY,
      primaryTitle: 'Private title',
      waitingAgents: [{ title: 'Private title', kind: 'permission' }],
      scheduledAgents: [],
    });
    for (const family of ACCESSORY_FAMILIES) {
      const tree = renderWidget(props, family);
      expect(collectOfKind(tree, 'Button')).toEqual([]);
      expect(collectText(tree)).not.toContain('Private title');
      expect(widgetURLs(tree)).toEqual(['kiloapp:///cloud/sessions']);
    }
  });

  it('draws a state glyph, never a placeholder dash, in the count-less circular', () => {
    const expected = {
      waiting: 'arrow.triangle.2.circlepath',
      empty: 'checkmark.circle.fill',
      privacy: 'lock.fill',
      signed_out: 'person.fill',
    } as const;
    for (const status of Object.keys(expected) as (keyof typeof expected)[]) {
      const snapshot = { ...snapshotFor([]), status };
      const home = buildHomeWidgetPresentation(
        { snapshot, details: EMPTY_HOME_WIDGET_DETAILS },
        NOW
      );
      const tree = renderWidget({ home }, 'accessoryCircular');
      const images = collectOfKind(tree, 'Image').map(image => image.props.systemName);
      expect(images).toEqual([expected[status]]);
      expect(collectText(tree)).not.toContain('—');
    }
  });

  it('names up to two waiting agents in the medium column and falls back to counts', () => {
    const waiting = renderWidget(
      homeProps([{ status: 'permission' }], {
        approvalKey: null,
        primaryTitle: 'First wait',
        waitingAgents: [
          { title: 'First wait', kind: 'permission' },
          { title: 'Second wait', kind: 'question' },
          { title: 'Third wait', kind: 'retry' },
        ],
        scheduledAgents: [],
      }),
      'systemMedium'
    );
    const texts = collectText(waiting);
    expect(texts).toContain('First wait');
    expect(texts).toContain('Second wait');
    expect(texts).not.toContain('Third wait');
    expect(texts).toContain('Permission required');
    // No entry rows: the column falls back to the support counts.
    const counts = renderWidget(
      homeProps([{ status: 'busy' }, { status: 'idle' }]),
      'systemMedium'
    );
    expect(collectText(counts)).toContain('Working');
    expect(collectText(counts)).toContain('Idle');
  });

  it.each(HOME_FAMILIES)(
    'keeps New agent navigation available alongside approval in %s',
    family => {
      const tree = renderWidget(homeProps([{ status: 'permission' }], APPROVABLE), family);
      const newAgent = pressButton(tree, { pendingAction: 'new-agent' });
      if (newAgent === undefined) {
        throw new Error(`New agent button missing in ${family}`);
      }
      expect(newAgent.props.openAppWhenRun).toBe(true);
      // The press records its own time, so the extension carries the marker only
      // while the press is younger than the TTL and a fresh press always resets it.
      const patch = (newAgent.props.onPress as () => { pendingActionAt: number })();
      expect(Math.abs(patch.pendingActionAt - Date.now())).toBeLessThan(1000);
      const approve = pressButton(tree, {
        pendingAction: 'approve',
        pendingApprovalKey: APPROVAL_KEY,
      });
      expect(approve).toBeDefined();
      expect(approve?.props.openAppWhenRun).toBeUndefined();
      expect(widgetURLs(tree)).toEqual(['kiloapp:///cloud/sessions']);
    }
  );

  it.each(HOME_FAMILIES)(
    'offers no blind Approve without a displayed request key in %s',
    family => {
      expect(
        pressButton(renderWidget(homeProps([{ status: 'permission' }]), family), {
          pendingAction: 'approve',
        })
      ).toBeUndefined();
    }
  );

  it.each(HOME_FAMILIES)(
    'holds both action hit slots in the same header across states in %s',
    family => {
      const states = [
        homeProps([{ status: 'permission' }], APPROVABLE),
        homeProps([]),
        homeProps([{ status: 'busy' }]),
      ];
      for (const props of states) {
        const root = renderWidget(props, family);
        const header = (root.props.children as { props: Record<string, unknown> }[])[0];
        const slots = (
          header?.props.children as { props: Record<string, unknown> }[] | undefined
        )?.slice(-2);
        expect(slots?.map(slot => slot.props.modifiers)).toEqual([
          [{ $type: 'frame', args: { width: 24, height: 24 } }],
          [{ $type: 'frame', args: { width: 24, height: 24 } }],
        ]);
      }
    }
  );

  it.each(HOME_FAMILIES)(
    'shows only nonzero Home counts and an honest checked footer in %s',
    family => {
      const props = homeProps([{ status: 'busy' }, { status: 'idle' }]);
      const texts = collectText(renderWidget(props, family));
      expect(texts).toContain('Working');
      expect(texts).not.toContain('Needs input');
      expect(texts).not.toContain('Scheduled');
      expect(texts).toContain('Checked');
      // The square card has no room for a relative phrase, so it prints the
      // clock time; the wide and large cards keep the relative form.
      const footer = collectOfKind(renderWidget(props, family), 'Text').find(
        text => text.props.dateStyle === (family === 'systemSmall' ? 'time' : 'ago')
      );
      expect(footer?.props.date).toEqual(new Date(NOW));
    }
  );

  it.each(HOME_FAMILIES)('retains old counts without asserting current work in %s', family => {
    const texts = collectText(
      renderWidget(
        homeProps([{ status: 'busy' }], EMPTY_HOME_WIDGET_DETAILS, NOW + 24 * 60 * 60 * 1000),
        family
      )
    );
    expect(texts).toContain('1');
    expect(texts).toContain('Last known');
    expect(texts).toContain('Checked');
    expect(texts).not.toContain('Status expired');
  });

  it.each(HOME_FAMILIES)('renders the scheduled wake even in the small family: %s', family => {
    const props = homeProps([{ status: 'scheduled', scheduledAt: SCHEDULED_WAKE }]);
    const tree = renderWidget(props, family);
    expect(
      collectOfKind(tree, 'Text').some(
        text => text.props.dateStyle === 'time' && text.props.date instanceof Date
      )
    ).toBe(true);
    expect(collectText(tree)).not.toContain('Idle');
  });

  it.each(HOME_FAMILIES)('does not invent running after a missed wake in %s', family => {
    const props = homeProps([
      { status: 'scheduled', scheduledAt: new Date(NOW - 1).toISOString() },
    ]);
    const texts = collectText(renderWidget(props, family));
    expect(texts).toContain('Awaiting update');
    expect(texts).toContain('Scheduled');
    expect(texts).not.toContain('Working');
  });

  it('shows bounded waiting and scheduled details in the large family', () => {
    const waiting = renderWidget(
      homeProps([{ status: 'question' }], {
        approvalKey: null,
        primaryTitle: 'First wait',
        waitingAgents: [
          { title: 'First wait', kind: 'question' },
          { title: 'Second wait', kind: 'retry' },
        ],
        scheduledAgents: [],
      }),
      'systemLarge'
    );
    expect(collectText(waiting)).toContain('Second wait');
    const scheduled = renderWidget(
      homeProps([{ status: 'scheduled', scheduledAt: SCHEDULED_WAKE }], {
        approvalKey: null,
        primaryTitle: 'Later job',
        waitingAgents: [],
        scheduledAgents: [
          { title: 'Later job', scheduledAt: SCHEDULED_WAKE },
          { title: '', scheduledAt: null },
        ],
      }),
      'systemLarge'
    );
    expect(collectText(scheduled)).toContain('Agent');
    expect(collectText(scheduled)).toContain('Awaiting update');
  });

  it.each(HOME_FAMILIES)(
    'keeps failure feedback visible with retained Home content in %s',
    family => {
      const tree = renderWidget(
        { ...homeProps([{ status: 'permission' }], APPROVABLE), actionLine: 'Could not approve' },
        family
      );
      expect(collectText(tree)).toContain('Could not approve');
      expect(
        pressButton(tree, { pendingAction: 'approve', pendingApprovalKey: APPROVAL_KEY })
      ).toBeDefined();
    }
  );

  it.each(HOME_FAMILIES)('renders empty, waiting, auth and privacy deliberately in %s', family => {
    for (const status of ['empty', 'waiting', 'signed_out', 'privacy'] as const) {
      const snapshot = { ...snapshotFor([]), status };
      const home = buildHomeWidgetPresentation(
        { snapshot, details: EMPTY_HOME_WIDGET_DETAILS },
        NOW
      );
      const tree = renderWidget({ home }, family);
      expect(collectText(tree)).toContain('Kilo');
      expect(collectText(tree).includes('Checked')).toBe(status === 'empty');
      expect(pressButton(tree, { pendingAction: 'approve' })).toBeUndefined();
      expect(pressButton(tree, { pendingAction: 'new-agent' }) !== undefined).toBe(
        status === 'empty'
      );
    }
  });

  it('contains malformed persisted props without throwing in any family', () => {
    const corrupt = {
      countLines: [null, { kind: 'unknown', count: 'bad', label: {} }],
      primaryKind: 'unknown',
      primaryLabel: {},
      primaryCount: Number.NaN,
      home: {
        status: 'unknown',
        secondaryCounts: [null, { kind: 'unknown' }],
        waitingAgents: [null],
        scheduledAgents: {},
        checkedAt: 'bad',
        scheduledAt: 'bad',
      },
    } as unknown as GlanceableWidgetProps;
    for (const family of [...HOME_FAMILIES, ...ACCESSORY_FAMILIES]) {
      expect(() => renderWidget(corrupt, family)).not.toThrow();
    }
  });

  it('does not use broken minimum scaling for long labels and large counts', () => {
    const props = homeProps([{ status: 'busy' }], {
      ...EMPTY_HOME_WIDGET_DETAILS,
      primaryTitle: 'A very long title '.repeat(20),
    });
    expect(props.home).toBeDefined();
    props.home = props.home && { ...props.home, primaryCount: 1_234_567_890 };
    for (const family of HOME_FAMILIES) {
      const tree = renderWidget(props, family);
      expect(collectText(tree)).toContain('1234567890');
      expect(
        collect(tree)
          .flatMap(element =>
            Array.isArray(element.props.modifiers)
              ? (element.props.modifiers as { $type?: string }[])
              : []
          )
          .some(modifier => modifier.$type === 'minimumScaleFactor')
      ).toBe(false);
    }
  });
});

/* eslint-disable max-lines -- one cohesive sweep + widget-layout suite sharing the expo-widgets/@expo/ui mock harness */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  GLANCEABLE_SNAPSHOT_EXPIRY_MS,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { _setLastGlanceableSnapshotForTests } from '@/lib/glanceable/persist';
import { getSurfaceExtras, setSurfaceExtras } from '@/lib/glanceable/surface-extras';

import { type UserInteractionEvent, type WidgetFamily } from 'expo-widgets';

import { activeAgentsWidgetLayout, WIDGET_NAME } from './active-agents-widget';
import {
  pendingActionForEvent,
  pendingActionOf,
  registerWidgetActionHandling,
  runPendingWidgetActions,
} from './widget-actions';
import {
  buildGlanceableViewProps,
  type GlanceableViewProps,
  type GlanceableWidgetProps,
} from './view-props';

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

// ── widget-prop fixtures ────────────────────────────────────────────────────

const HAPPY_WAITING_PROPS: Partial<GlanceableViewProps> = {
  statusLine: null,
  countLines: [
    { label: 'Needs input', kind: 'needsInput', count: 1 },
    { label: 'Working', kind: 'running', count: 1 },
    { label: 'Idle', kind: 'idle', count: 0 },
  ],
  primaryLabel: 'Needs input',
  primaryKind: 'needsInput',
  primaryCount: 1,
  newestTitle: 'Newest: Fix the flaky test',
  actions: { approve: true, newAgent: false },
  needsInputSince: null,
  accessibilityLabel: 'spoken label',
};

const EMPTY_WIDGET_PROPS: Partial<GlanceableViewProps> = {
  statusLine: 'No agents waiting',
  countLines: [],
  primaryLabel: null,
  primaryKind: null,
  primaryCount: 0,
  newestTitle: null,
  actions: { approve: false, newAgent: true },
  needsInputSince: null,
  accessibilityLabel: 'spoken label',
};

const SIGNED_OUT_PROPS: Partial<GlanceableViewProps> = {
  statusLine: 'Sign in to see agents',
  countLines: [],
  primaryLabel: null,
  primaryKind: null,
  primaryCount: 0,
  newestTitle: null,
  actions: { approve: false, newAgent: false },
  needsInputSince: null,
  accessibilityLabel: 'spoken label',
};

/** One scheduled session and nothing else: the wake rides beside its row. */
const SCHEDULED_WAKE = '2026-09-24T09:00:00.000Z';

const SCHEDULED_PROPS: Partial<GlanceableViewProps> = {
  statusLine: null,
  countLines: [
    { label: 'Needs input', kind: 'needsInput', count: 0 },
    { label: 'Working', kind: 'running', count: 0 },
    { label: 'Scheduled', kind: 'scheduled', count: 1 },
    { label: 'Idle', kind: 'idle', count: 0 },
  ],
  primaryLabel: 'Scheduled',
  primaryKind: 'scheduled',
  primaryCount: 1,
  newestTitle: null,
  actions: { approve: false, newAgent: false },
  needsInputSince: null,
  scheduledAt: SCHEDULED_WAKE,
  accessibilityLabel: 'spoken label',
};

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

/**
 * The scheduled wake: the one `Text` the layout draws as an absolute clock
 * time (`dateStyle="time"`). The needs-input wait and the newest-result age are
 * relative durations, so the style is what tells the wake apart.
 */
function wakeTexts(node: unknown): MockElement[] {
  return collect(node).filter(
    element => element.kind === 'Text' && element.props.dateStyle === 'time'
  );
}

/** The count row whose own label is `label`, found through its direct children. */
function countRowFor(node: unknown, label: string): MockElement | undefined {
  return collect(node).find(element => {
    const children = element.props.children;
    return (
      element.kind === 'HStack' &&
      Array.isArray(children) &&
      children.some(
        child => (child as { props?: { children?: unknown } } | null)?.props?.children === label
      )
    );
  });
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

function pressButton(tree: unknown, patch: { pendingAction: string }): MockElement | undefined {
  return collect(tree).find(
    element =>
      element.kind === 'Button' &&
      typeof element.props.onPress === 'function' &&
      (element.props.onPress as () => { pendingAction: string })().pendingAction ===
        patch.pendingAction
  );
}

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
    widgetState.timeline = [{ date: new Date(1), props: { pendingAction: 'approve' } }];
    mocks.runWidgetApprove.mockResolvedValue({ kind: 'failed' });
    _setLastGlanceableSnapshotForTests(snapshotFor([{ status: 'permission' }]));

    await runPendingWidgetActions();

    expect(getSurfaceExtras().actionFeedback).toBe('couldNotApprove');
    expect(widgetState.snapshots).toHaveLength(1);
    expect(widgetState.snapshots[0]).toMatchObject({
      newestTitle: 'glanceable.couldNotApprove',
      // Approve is still available: the call failed, not the work.
      actions: { approve: true, newAgent: false },
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

/** A recorded swift-ui modifier, typed the way the mock stubs record it. */
type MockModifier = { $type?: string; args?: Record<string, unknown> };

/** The recorded modifiers on an element, never any other prop. */
function mockModifiers(element: MockElement | undefined): MockModifier[] {
  const modifiers = element?.props.modifiers;
  return Array.isArray(modifiers) ? (modifiers as MockModifier[]) : [];
}

/**
 * The reserved newest-session slot: the one container whose `frame` pins a
 * height and nothing else. The mark's own frame pins both a width and a
 * height, so this finds the slot by shape rather than by position.
 */
function reservedSlot(tree: unknown): MockElement | undefined {
  return collect(tree).find(element =>
    mockModifiers(element).some(
      modifier =>
        modifier.$type === 'frame' &&
        modifier.args !== undefined &&
        'height' in modifier.args &&
        !('width' in modifier.args)
    )
  );
}

/** The height the slot's frame pins, or undefined when it pins none. */
function slotHeight(element: MockElement | undefined): number | undefined {
  const frameModifier = mockModifiers(element).find(modifier => modifier.$type === 'frame');
  return frameModifier?.args?.height as number | undefined;
}

describe('activeAgentsWidgetLayout', () => {
  it('keeps the Lock Screen families generic: no title and no buttons', () => {
    const lockScreenFamilies: WidgetFamily[] = [
      'accessoryCircular',
      'accessoryInline',
      'accessoryRectangular',
    ];
    for (const family of lockScreenFamilies) {
      const tree = renderWidget(HAPPY_WAITING_PROPS, family);
      expect(collectOfKind(tree, 'Button')).toEqual([]);
      expect(collectText(tree)).not.toContain('Newest: Fix the flaky test');
      expect(widgetURLs(tree)).toEqual(['kiloapp:///cloud/sessions']);
    }
  });

  it('renders a stored count row that carries no label in every family', () => {
    // A timeline another app version wrote can hold a row without a string
    // label; a throw here is the red error box in every family.
    const props = {
      ...HAPPY_WAITING_PROPS,
      countLines: [{ count: 2, kind: 'needsInput' }],
    } as unknown as GlanceableWidgetProps;
    const families: WidgetFamily[] = ['systemSmall', 'systemMedium', 'systemLarge'];
    for (const family of families) {
      expect(() => renderWidget(props, family)).not.toThrow();
    }
  });

  it('draws the newest-session line and the Approve button in the small family', () => {
    const tree = renderWidget(HAPPY_WAITING_PROPS, 'systemSmall');

    const button = pressButton(tree, { pendingAction: 'approve' });
    expect(button).toBeDefined();
    const pressApprove = button?.props.onPress as (() => unknown) | undefined;
    expect(pressApprove?.()).toEqual({
      pendingAction: 'approve',
    });
    // Approve answers in place: its intent must not foreground the app.
    expect(button?.props.openAppWhenRun).toBeUndefined();
    expect(collectText(tree)).toContain('Newest: Fix the flaky test');
    // The body keeps its own deep link: a tap beside the buttons opens Kilo.
    expect(widgetURLs(tree)).toEqual(['kiloapp:///cloud/sessions']);
  });

  it('reserves the newest-session slot with and without a line in both Home Screen families', () => {
    for (const family of ['systemSmall', 'systemMedium'] as WidgetFamily[]) {
      const filled = renderWidget(HAPPY_WAITING_PROPS, family);
      // The same props with no title: the state a process restart starts from,
      // before the first snapshot answers with a session.
      const blank = renderWidget({ ...HAPPY_WAITING_PROPS, newestTitle: null }, family);

      const filledSlot = reservedSlot(filled);
      const blankSlot = reservedSlot(blank);
      // The slot is its own container with a fixed height in every state, so a
      // title arriving late, an approve's progress line taking the slot, and the
      // answer replacing it move neither the count rows above nor the action row below.
      expect(filledSlot?.kind).toBe('VStack');
      expect(blankSlot?.kind).toBe('VStack');
      expect(slotHeight(filledSlot)).toBe(slotHeight(blankSlot));
      expect(slotHeight(filledSlot)).toBeGreaterThan(0);

      // Only the line differs, never the space reserved around it.
      expect(collectText(filled)).toContain('Newest: Fix the flaky test');
      expect(collectText(blank)).not.toContain('Newest: Fix the flaky test');
    }
  });

  it('draws the New agent button for the empty state and no Approve button', () => {
    const tree = renderWidget(EMPTY_WIDGET_PROPS, 'systemSmall');

    const button = pressButton(tree, { pendingAction: 'new-agent' });
    expect(button).toBeDefined();
    const pressNewAgent = button?.props.onPress as (() => unknown) | undefined;
    expect(pressNewAgent?.()).toEqual({
      pendingAction: 'new-agent',
    });
    // New agent needs the composer: its intent foregrounds the app, or the tap
    // only marks the timeline until the next launch.
    expect(button?.props.openAppWhenRun).toBe(true);
    expect(pressButton(tree, { pendingAction: 'approve' })).toBeUndefined();
    expect(collectText(tree)).toContain('No agents waiting');
  });

  it('draws no button for a signed-out surface', () => {
    const tree = renderWidget(SIGNED_OUT_PROPS, 'systemMedium');

    expect(collectOfKind(tree, 'Button')).toEqual([]);
    expect(collectText(tree)).toContain('Sign in to see agents');
  });

  it('styles the widget buttons as small bordered actions', () => {
    const tree = renderWidget(HAPPY_WAITING_PROPS, 'systemSmall');

    const button = pressButton(tree, { pendingAction: 'approve' });
    const styles = (button?.props.modifiers as { $type: string }[] | undefined)?.map(
      modifier => modifier.$type
    );
    expect(styles).toContain('buttonStyle');
    expect(styles).toContain('controlSize');
  });

  // The large card is a wide card with a footer, so it draws the scheduled
  // wake beside its row exactly as the medium card does — the same information
  // the Android widget of that size shows. The small square has no room.
  it('draws the scheduled wake in the large card, the same as the medium one', () => {
    for (const family of ['systemMedium', 'systemLarge'] as WidgetFamily[]) {
      const wake = wakeTexts(renderWidget(SCHEDULED_PROPS, family));

      expect(wake).toHaveLength(1);
      expect(wake[0]?.props.date).toEqual(new Date(SCHEDULED_WAKE));
    }
    expect(wakeTexts(renderWidget(SCHEDULED_PROPS, 'systemSmall'))).toEqual([]);
  });

  it('reserves the wake slot beside the scheduled row in the medium and large cards', () => {
    for (const family of ['systemMedium', 'systemLarge'] as WidgetFamily[]) {
      const row = countRowFor(renderWidget(SCHEDULED_PROPS, family), 'Scheduled');

      // The trailing slot is laid out whether or not a wake is known, so a
      // wake the CLI reports later cannot move the row.
      expect(collect(row?.props.children).some(element => element.kind === 'Spacer')).toBe(true);
    }
    const smallRow = countRowFor(renderWidget(SCHEDULED_PROPS, 'systemSmall'), 'Scheduled');
    expect(collect(smallRow?.props.children).some(element => element.kind === 'Spacer')).toBe(
      false
    );
  });

  it('never scales a count-row label in any family', () => {
    // In the widget renderer a scaling label always drew at its minimum scale,
    // far smaller than its count.
    const families: WidgetFamily[] = [
      'systemSmall',
      'systemMedium',
      'systemLarge',
      'accessoryRectangular',
    ];
    for (const family of families) {
      const row = countRowFor(renderWidget(HAPPY_WAITING_PROPS, family), 'Needs input');
      const label = collectOfKind(row?.props.children, 'Text').find(
        text => text.props.children === 'Needs input'
      );
      expect(label).toBeDefined();
      expect(mockModifiers(label).map(modifier => modifier.$type)).not.toContain(
        'minimumScaleFactor'
      );
    }
  });

  it('offers the action in the large card', () => {
    const approve = pressButton(renderWidget(HAPPY_WAITING_PROPS, 'systemLarge'), {
      pendingAction: 'approve',
    });
    expect(approve).toBeDefined();

    const empty = renderWidget(EMPTY_WIDGET_PROPS, 'systemLarge');
    expect(pressButton(empty, { pendingAction: 'new-agent' })?.props.openAppWhenRun).toBe(true);
    expect(collectText(empty)).toContain('No agents waiting');
  });

  it('names an Approve in flight on the large card, which has no reserved slot', () => {
    const failed = renderWidget(
      { ...HAPPY_WAITING_PROPS, actionLine: 'Could not approve' },
      'systemLarge'
    );
    expect(collectText(failed)).toContain('Could not approve');
    expect(collectText(renderWidget(HAPPY_WAITING_PROPS, 'systemLarge'))).not.toContain(
      'Could not approve'
    );
  });

  it('drops a row time whole when its label is too long for the large card', () => {
    const props: GlanceableWidgetProps = {
      ...SCHEDULED_PROPS,
      countLines: [
        { label: 'Needs input', kind: 'needsInput', count: 0 },
        { label: 'Working', kind: 'running', count: 0 },
        { label: 'En espera de respuesta', kind: 'scheduled', count: 1 },
        { label: 'Idle', kind: 'idle', count: 0 },
      ],
    };
    expect(wakeTexts(renderWidget(props, 'systemLarge'))).toEqual([]);
    expect(wakeTexts(renderWidget(props, 'systemMedium'))).toHaveLength(1);
  });

  it('leads with the rows that have work and mutes the zero rows', () => {
    const labels = (tree: unknown): unknown[] =>
      collectOfKind(tree, 'Text')
        .map(text => text.props.children)
        .filter(copy => ['Needs input', 'Working', 'Scheduled', 'Idle'].includes(copy as string));
    for (const family of [
      'systemLarge',
      'systemMedium',
      'accessoryRectangular',
    ] as WidgetFamily[]) {
      const tree = renderWidget(SCHEDULED_PROPS, family);

      // Scheduled is the one row with work: it leads, the zeros keep their
      // grid order after it.
      expect(labels(tree)).toEqual(['Scheduled', 'Needs input', 'Working', 'Idle']);

      // A zero row draws fully muted: the label and the number in the
      // secondary colour, the number without its emphasis.
      const muted = countRowFor(tree, 'Working');
      const mutedLabel = collectOfKind(muted?.props.children, 'Text').find(
        text => text.props.children === 'Working'
      );
      expect(mockModifiers(mutedLabel).map(modifier => modifier.args)).toContain('secondaryLabel');
      const mutedNumber = collectOfKind(muted?.props.children, 'Text').find(
        text => text.props.children === '0'
      );
      expect(mockModifiers(mutedNumber).find(m => m.$type === 'font')?.args).toMatchObject({
        weight: 'regular',
      });
    }
  });

  it('sits the wait and the wake in one trailing column on the medium and large cards', () => {
    const props: GlanceableWidgetProps = {
      ...SCHEDULED_PROPS,
      needsInputSince: '2026-09-24T08:00:00.000Z',
      countLines: [
        { label: 'Needs input', kind: 'needsInput', count: 2 },
        { label: 'Scheduled', kind: 'scheduled', count: 1 },
      ],
    };
    for (const family of ['systemMedium', 'systemLarge'] as WidgetFamily[]) {
      const tree = renderWidget(props, family);
      for (const label of ['Needs input', 'Scheduled']) {
        const row = countRowFor(tree, label);
        // The row fills the card's width, so its time lands in the same
        // trailing column as every other row's.
        expect(mockModifiers(row).map(modifier => modifier.$type)).toContain('frame');
      }
    }
  });

  it('scales the count-less large card up', () => {
    const tree = renderWidget(EMPTY_WIDGET_PROPS, 'systemLarge');

    // The mark, the status line and the control all grow with the card, or the
    // composition reads as a stamp in a big card.
    const mark = collectOfKind(tree, 'Image')[0];
    expect(mockModifiers(mark).find(m => m.$type === 'frame')?.args).toMatchObject({ width: 56 });
    const status = collectOfKind(tree, 'Text').find(
      text => text.props.children === 'No agents waiting'
    );
    expect(mockModifiers(status).find(m => m.$type === 'font')?.args).toMatchObject({
      textStyle: 'title3',
    });
    const button = pressButton(tree, { pendingAction: 'new-agent' });
    expect(mockModifiers(button).find(m => m.$type === 'controlSize')?.args).toBe('regular');
  });
});

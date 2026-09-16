/* eslint-disable max-lines -- one cohesive sweep + widget-layout suite sharing the expo-widgets/@expo/ui mock harness */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
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
import { buildGlanceableViewProps, type GlanceableViewProps } from './view-props';

// The widget surfaces are unreachable under vitest: the swift-ui primitives are
// recording stubs, react-native is stubbed, and expo-widgets' factories are
// stubs with a controllable timeline — so the sweep and the stringified layout
// are the real logic under test.
const widgetState = vi.hoisted(() => ({
  timeline: [] as { date: Date; props: Record<string, unknown> }[],
  snapshots: [] as unknown[],
  listeners: [] as ((event: { source: string; target: string; timestamp: number }) => void)[],
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
    getTimeline: () => widgetState.timeline,
    reload: () => undefined,
  }),
  addUserInteractionListener: (
    listener: (event: { source: string; target: string; timestamp: number }) => void
  ) => {
    widgetState.listeners.push(listener);
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
  resizable: mockModifier('resizable'),
  widgetURL: mockModifier('widgetURL'),
}));

const mocks = vi.hoisted(() => ({
  runWidgetAction: vi.fn<() => Promise<{ kind: string }>>(),
  linkingOpenURL: vi.fn<() => Promise<void>>(),
  lastSnapshot: null as GlanceableAgentsSnapshot | null,
}));

vi.mock('@/lib/glanceable/widget-actions', () => ({ runWidgetAction: mocks.runWidgetAction }));
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

function snapshotFor(sessions: { status: string }[]): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
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
    mocks.runWidgetAction.mockReset();
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
        props: { primaryCount: 1, pendingAction: 'approve', pendingActionVisible: true },
      },
    ];
    // Hold the action in flight so the test can inspect the stored timeline
    // while the action is running.
    const gate = Promise.withResolvers<{ kind: string }>();
    mocks.runWidgetAction.mockImplementation(async () => {
      await gate.promise;
      return { kind: 'approved' };
    });
    const sweep = runPendingWidgetActions();

    // The marker was already gone from the stored timeline while the action
    // was still running: a crash mid-action reads as a dropped press, never a
    // repeated one.
    await vi.waitFor(() => {
      expect(widgetState.timeline[0]?.props).not.toHaveProperty('pendingAction');
      expect(widgetState.timeline[0]?.props).not.toHaveProperty('pendingActionVisible');
    });
    gate.resolve({ kind: 'approved' });
    await sweep;

    expect(mocks.runWidgetAction).toHaveBeenCalledWith('approve');
    expect(widgetState.timeline[0]?.props).toMatchObject({ primaryCount: 1 });
  });

  it('strips the marker only from pressed entries and keeps every frame', async () => {
    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'new-agent', pendingActionVisible: true } },
      { date: new Date(2), props: { statusLine: 'Updates delayed' } },
    ];
    mocks.runWidgetAction.mockResolvedValue({ kind: 'created' });

    await runPendingWidgetActions();

    expect(widgetState.timeline).toEqual([
      { date: new Date(1), props: {} },
      { date: new Date(2), props: { statusLine: 'Updates delayed' } },
    ]);
    expect(mocks.runWidgetAction).toHaveBeenCalledWith('new-agent');
  });

  it('never runs the same press twice on a second sweep', async () => {
    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'approve', pendingActionVisible: true } },
    ];
    mocks.runWidgetAction.mockResolvedValue({ kind: 'approved' });

    await runPendingWidgetActions();
    await runPendingWidgetActions();

    expect(mocks.runWidgetAction).toHaveBeenCalledTimes(1);
  });

  it('never runs the same press twice on overlapping sweeps', async () => {
    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'approve', pendingActionVisible: true } },
    ];
    const gate = Promise.withResolvers<{ kind: string }>();
    mocks.runWidgetAction.mockImplementation(async () => {
      await gate.promise;
      return { kind: 'approved' };
    });
    const first = runPendingWidgetActions();
    const second = runPendingWidgetActions();
    gate.resolve({ kind: 'approved' });
    await Promise.all([first, second]);

    expect(mocks.runWidgetAction).toHaveBeenCalledTimes(1);
  });

  it('maps a live interaction event through the marker and runs it once', async () => {
    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'approve', pendingActionVisible: true } },
    ];
    mocks.runWidgetAction.mockResolvedValue({ kind: 'approved' });
    registerWidgetActionHandling();
    // The launch sweep already picked the cold-start press up.
    await vi.waitFor(() => {
      expect(mocks.runWidgetAction).toHaveBeenCalledTimes(1);
    });

    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'approve', pendingActionVisible: true } },
    ];
    widgetState.listeners[0]?.({
      source: WIDGET_NAME,
      target: '__expo_widgets_target_0',
      timestamp: NOW,
    });
    await vi.waitFor(() => {
      expect(mocks.runWidgetAction).toHaveBeenCalledTimes(2);
    });

    // Another widget kind's press owns no marker here, and this sweep must not
    // run this widget's marker on its behalf.
    widgetState.listeners[0]?.({
      source: 'ActiveAgentsLiveActivity',
      target: '__expo_widgets_target_0',
      timestamp: NOW,
    });
    expect(mocks.runWidgetAction).toHaveBeenCalledTimes(2);
  });

  it("pushes the couldn't-approve feedback and fresh props when the approve fails", async () => {
    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'approve', pendingActionVisible: true } },
    ];
    mocks.runWidgetAction.mockResolvedValue({ kind: 'failed' });
    _setLastGlanceableSnapshotForTests(snapshotFor([{ status: 'question' }]));

    await runPendingWidgetActions();

    expect(getSurfaceExtras().actionFeedback).toBe('couldNotApprove');
    expect(widgetState.snapshots).toHaveLength(1);
    expect(widgetState.snapshots[0]).toMatchObject({
      newestTitle: 'glanceable.couldNotApprove',
      // Approve is still available: the call failed, not the work.
      actions: { approve: true, newAgent: false },
    });
  });

  it('clears the previous failure line before a retried approve runs', async () => {
    // The first press failed and left its line owning the reserved slot.
    setSurfaceExtras({
      newestSessionTitle: 'Fix the flaky test',
      actionFeedback: 'couldNotApprove',
    });
    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'approve', pendingActionVisible: true } },
    ];
    let feedbackDuringRun: string | null = 'not captured';
    let newestDuringRun: string | null = 'not captured';
    const gate = Promise.withResolvers<{ kind: string }>();
    mocks.runWidgetAction.mockImplementation(async () => {
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

  it('pushes fresh props and hands a create with nothing to start from to the app', async () => {
    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'new-agent', pendingActionVisible: true } },
    ];
    mocks.runWidgetAction.mockResolvedValue({ kind: 'none' });
    _setLastGlanceableSnapshotForTests(snapshotFor([{ status: 'question' }]));

    await runPendingWidgetActions();

    expect(getSurfaceExtras().actionFeedback).toBeNull();
    expect(widgetState.snapshots).toHaveLength(1);
    // `none` is the shared contract's "caller opens the app instead": the
    // create had no draft, model, or repository, so the press lands on the
    // new-session screen — the same destination the Android twin opens.
    expect(mocks.linkingOpenURL).toHaveBeenCalledWith('kiloapp://agent-chat/new');
  });

  it('hands an approve with nothing to act on to the agents list', async () => {
    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'approve', pendingActionVisible: true } },
    ];
    mocks.runWidgetAction.mockResolvedValue({ kind: 'none' });

    await runPendingWidgetActions();

    expect(mocks.linkingOpenURL).toHaveBeenCalledWith('kiloapp:///cloud/sessions');
  });

  it('hands a question-waiting approve to the app instead of inventing an answer', async () => {
    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'approve', pendingActionVisible: true } },
    ];
    mocks.runWidgetAction.mockResolvedValue({ kind: 'no-permission' });

    await runPendingWidgetActions();

    expect(mocks.linkingOpenURL).toHaveBeenCalledWith('kiloapp:///cloud/sessions');
  });

  it('keeps a failed press on the widget without opening the app', async () => {
    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'approve', pendingActionVisible: true } },
    ];
    mocks.runWidgetAction.mockResolvedValue({ kind: 'failed' });

    await runPendingWidgetActions();

    expect(mocks.linkingOpenURL).not.toHaveBeenCalled();
  });

  it('leaves the answering to the republishing sink on a successful action', async () => {
    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'approve', pendingActionVisible: true } },
    ];
    mocks.runWidgetAction.mockResolvedValue({ kind: 'approved' });
    _setLastGlanceableSnapshotForTests(snapshotFor([{ status: 'busy' }]));

    await runPendingWidgetActions();

    expect(widgetState.snapshots).toEqual([]);
    expect(getSurfaceExtras().actionFeedback).toBeNull();
  });

  it('sweeps nothing when no entry carries a marker', async () => {
    widgetState.timeline = [{ date: new Date(1), props: { primaryCount: 1 } }];

    await runPendingWidgetActions();

    expect(mocks.runWidgetAction).not.toHaveBeenCalled();
    expect(widgetState.timeline).toEqual([{ date: new Date(1), props: { primaryCount: 1 } }]);
  });

  it('sweeps a cold-start press without a snapshot to rebuild from', async () => {
    widgetState.timeline = [
      { date: new Date(1), props: { pendingAction: 'approve', pendingActionVisible: true } },
    ];
    mocks.runWidgetAction.mockResolvedValue({ kind: 'none' });

    await runPendingWidgetActions();

    // The marker is still cleared in place, so the widget stops claiming the
    // press even though no snapshot exists to rebuild full props from.
    expect(widgetState.timeline[0]?.props).toEqual({});
  });
});

// ── the stringified layout ──────────────────────────────────────────────────

function renderWidget(props: Partial<GlanceableViewProps>, family: WidgetFamily): MockElement {
  return activeAgentsWidgetLayout(props, {
    widgetFamily: family,
    date: new Date(0),
    configuration: undefined,
  }) as unknown as MockElement;
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

  it('draws the newest-session line and the Approve button in the small family', () => {
    const tree = renderWidget(HAPPY_WAITING_PROPS, 'systemSmall');

    const button = pressButton(tree, { pendingAction: 'approve' });
    expect(button).toBeDefined();
    const pressApprove = button?.props.onPress as (() => unknown) | undefined;
    expect(pressApprove?.()).toEqual({
      pendingAction: 'approve',
      pendingActionVisible: true,
    });
    expect(collectText(tree)).toContain('Newest: Fix the flaky test');
    // The body keeps its own deep link: a tap beside the buttons opens Kilo.
    expect(widgetURLs(tree)).toEqual(['kiloapp:///cloud/sessions']);
  });

  it('draws the New agent button for the empty state and no Approve button', () => {
    const tree = renderWidget(EMPTY_WIDGET_PROPS, 'systemSmall');

    const button = pressButton(tree, { pendingAction: 'new-agent' });
    expect(button).toBeDefined();
    const pressNewAgent = button?.props.onPress as (() => unknown) | undefined;
    expect(pressNewAgent?.()).toEqual({
      pendingAction: 'new-agent',
      pendingActionVisible: true,
    });
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
});

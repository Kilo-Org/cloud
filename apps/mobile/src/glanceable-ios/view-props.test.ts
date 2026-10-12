import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
  type GlanceableSessionRow,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { EMPTY_HOME_WIDGET_DETAILS, type HomeWidgetData } from '@kilocode/app-shared/home-widget';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withStatus } from '@/lib/glanceable/publisher';
import { setSurfaceExtras } from '@/lib/glanceable/surface-extras';

import {
  buildGlanceableLiveActivityContentState,
  buildGlanceableViewProps,
  toWidgetProps,
  widgetTimelineFrames,
} from './view-props';

const NOW = Date.parse('2026-01-02T00:00:00Z');

const COPY: Record<string, string> = {
  'glanceable.approving': 'Approving…',
  'glanceable.couldNotApprove': 'Could not approve',
  'glanceable.newestSession': 'Newest: {{title}}',
};
const translate = (key: string): string => COPY[key] ?? key;

// The extras are module state shared by the publisher and every surface; a case
// that sets them resets them here so it cannot colour the next one.
afterEach(() => {
  setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
  vi.useRealTimers();
});

function snapshotFor(
  sessions: readonly GlanceableSessionRow[] = [],
  status?: GlanceableAgentsSnapshot['status']
): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
    ...(status === undefined ? {} : { status }),
  });
}

const PERMISSION_ROW: GlanceableSessionRow = {
  status: 'permission',
  statusUpdatedAt: '2026-01-01T00:00:00.000Z',
};
const QUESTION_ROW: GlanceableSessionRow = {
  status: 'question',
  statusUpdatedAt: '2026-01-01T00:00:00.000Z',
};

describe('newestTitleFor', () => {
  it.each([
    ['approving', 'Approving…'],
    ['couldNotApprove', 'Could not approve'],
  ] as const)('renders the %s action feedback on a happy surface', (feedback, expected) => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: feedback });
    const props = buildGlanceableViewProps(snapshotFor([{ status: 'question' }]), {}, translate);
    expect(props.newestTitle).toBe(expected);
  });

  it('never draws the reserved line on a locked surface, even with feedback set', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: 'approving' });
    expect(
      buildGlanceableViewProps(snapshotFor([], 'signed_out'), { signedOut: true }, translate)
        .newestTitle
    ).toBeNull();
    expect(
      buildGlanceableViewProps(snapshotFor([], 'expired'), {}, translate).newestTitle
    ).toBeNull();
    expect(
      buildGlanceableViewProps(snapshotFor([], 'waiting'), {}, translate).newestTitle
    ).toBeNull();
  });

  it('keeps the newest session’s title unchanged on a happy surface', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: null });
    const props = buildGlanceableViewProps(snapshotFor([{ status: 'question' }]), {}, translate);
    expect(props.newestTitle).toBe('Newest: Fix the flaky test');
  });

  it('never shows the newest-session title on the empty surface', () => {
    // Empty offers no in-place action, so its slot stays blank rather than
    // carrying a stale title.
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: null });
    expect(
      buildGlanceableViewProps(snapshotFor([], 'empty'), {}, translate).newestTitle
    ).toBeNull();
  });
});

describe('actions', () => {
  it('offers New agent when every connected agent is idle and nothing waits', () => {
    // The idle-only tray has status happy: it keeps a card alive, and nothing
    // waiting means the only action the surface can offer is a new agent.
    const props = buildGlanceableViewProps(snapshotFor([{ status: 'idle' }]), {}, translate);
    expect(props.actions).toEqual({ approve: false, newAgent: true });
  });

  it('keeps New agent available when a session is scheduled', () => {
    const props = buildGlanceableViewProps(snapshotFor([{ status: 'scheduled' }]), {}, translate);
    expect(props.actions).toEqual({ approve: false, newAgent: true });
    expect(props.primaryKind).toBe('scheduled');
  });

  it('carries the soonest wake, or null when a scheduled row has none', () => {
    const later = '2026-09-24T10:00:00.000Z';
    const sooner = '2026-09-24T09:00:00.000Z';
    const withWake = buildGlanceableViewProps(
      snapshotFor([
        { status: 'scheduled', scheduledAt: later },
        { status: 'scheduled', scheduledAt: sooner },
      ]),
      {},
      translate
    );
    // The count row exists whether or not a wake is known, so the surface
    // never reflows when the CLI reports a wake for a session it had none for;
    // only the time beside the row is conditional.
    expect(withWake.countLines.find(line => line.kind === 'scheduled')).toEqual({
      label: 'common.scheduled',
      kind: 'scheduled',
      count: 2,
    });
    expect(withWake.scheduledAt).toBe(sooner);
    expect(withWake.primaryKind).toBe('scheduled');

    const noWake = buildGlanceableViewProps(snapshotFor([{ status: 'scheduled' }]), {}, translate);
    expect(noWake.countLines.find(line => line.kind === 'scheduled')?.count).toBe(1);
    expect(noWake.scheduledAt).toBeNull();
  });

  it('offers New agent alongside Approve while the displayed permission waits', () => {
    const snapshot = snapshotFor([PERMISSION_ROW]);
    const props = buildGlanceableViewProps(snapshot, {}, translate, {
      snapshot,
      details: { ...EMPTY_HOME_WIDGET_DETAILS, approvalKey: 'a'.repeat(64) },
    });
    expect(props.actions).toEqual({ approve: true, newAgent: true });
  });

  it('offers no blind Approve while the displayed request is unknown', () => {
    const props = buildGlanceableViewProps(snapshotFor([PERMISSION_ROW]), {}, translate);
    expect(props.actions).toEqual({ approve: false, newAgent: true });
  });

  it.each(['question', 'retry'] as const)(
    'offers no Approve for a %s wait the action cannot answer',
    status => {
      // `needsInput` folds in questions and retries: a question needs an answer
      // and a retry needs the provider back, so neither may draw a button whose
      // press only finds nothing to approve and opens the app instead.
      const props = buildGlanceableViewProps(snapshotFor([{ status }]), {}, translate);
      expect(props.actions).toEqual({ approve: false, newAgent: true });
    }
  );
});

/**
 * The approvable count gates every Approve control: the Live Activity's wrist
 * control and the Home Screen widget's in-place button both read it. It is
 * narrower than `needsInput` on purpose: only a permission prompt can be
 * answered without choosing an option, so a question or a retry must never
 * raise a control whose answer is "open the app".
 */
describe('buildGlanceableLiveActivityContentState needsApproval', () => {
  it('forwards one permission wait as 1', () => {
    const built = snapshotFor([PERMISSION_ROW]);
    expect(built.needsApproval).toBe(1);
    expect(buildGlanceableLiveActivityContentState(built).needsApproval).toBe(1);
  });

  it('forwards a question-only wait as 0, though it is still needs-input', () => {
    const built = snapshotFor([QUESTION_ROW]);
    expect(built.needsInput).toBe(1);
    expect(buildGlanceableLiveActivityContentState(built).needsApproval).toBe(0);
  });

  it('reads an absent field on an old snapshot as 0, never undefined', () => {
    // An older producer omits `needsApproval` from the pushed shape. The
    // content state must still carry a number: the layout compares it with
    // `> 0` and must not draw the control for a value it cannot read.
    const { needsApproval: _omitted, ...oldSnapshot } = snapshotFor([PERMISSION_ROW]);
    const contentState = buildGlanceableLiveActivityContentState(
      oldSnapshot as GlanceableAgentsSnapshot
    );
    expect(contentState.needsApproval).toBe(0);
  });

  it('expires to a frame with no counts while keeping the approvable count', () => {
    // The fetch-error path (`handleFetchError`) advances the retained card with
    // `withStatus(..., 'stale', now)`: past `expiresAt` it zeroes every count
    // but leaves `needsApproval` standing. The layout gates the Approve control
    // on the counts too (`hasCounts && needsApproval`), so this frame draws no
    // control; this test pins the exact shape that gate defends against.
    const current = snapshotFor([PERMISSION_ROW]);
    expect(current.needsApproval).toBe(1);
    const expired = withStatus(current, 'stale', Date.parse(current.expiresAt));

    expect(expired.status).toBe('expired');
    const contentState = buildGlanceableLiveActivityContentState(expired);
    expect(contentState.needsInput).toBe(0);
    expect(contentState.running).toBe(0);
    expect(contentState.idle).toBe(0);
    // Survives expiry — which is exactly why the layout cannot gate on it alone.
    expect(contentState.needsApproval).toBe(1);
  });

  it('keeps the approvable count off the widget props', () => {
    // The Live Activity is the surface that reads `needsApproval`; the Home
    // Screen widget and the complication render `GlanceableViewProps`, whose
    // Approve button is driven by the retained wait itself. Assert the whole
    // key set so the approvable count (or any other field) cannot silently
    // ship onto a widget shape that has no use for it; the newest-result trio
    // is the deliberate read-only data the large card draws in its footer.
    const snapshot = snapshotFor([PERMISSION_ROW]);
    const props = buildGlanceableViewProps(snapshot, {}, translate, {
      snapshot,
      details: { ...EMPTY_HOME_WIDGET_DETAILS, approvalKey: 'a'.repeat(64) },
    });
    expect(props.home?.canApprove).toBe(true);
    expect(props.home?.canCreate).toBe(true);
    expect('needsApproval' in props).toBe(false);
    expect(toWidgetProps(props)).not.toHaveProperty('needsApproval');
  });
});

describe('Home-only presentation and timeline', () => {
  it('keeps retained Home work separate from expired accessory counts', () => {
    const retained: HomeWidgetData = {
      snapshot: snapshotFor([PERMISSION_ROW]),
      details: {
        approvalKey: 'a'.repeat(64),
        primaryTitle: 'Private title',
        waitingAgents: [{ title: 'Private title', kind: 'permission' }],
        scheduledAgents: [],
      },
    };
    const expired = withStatus(retained.snapshot, 'stale', Date.parse(retained.snapshot.expiresAt));
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: 'couldNotApprove' });
    const props = buildGlanceableViewProps(
      expired,
      {},
      translate,
      retained,
      Date.parse(expired.expiresAt)
    );
    expect(props.countLines).toEqual([]);
    expect(props.home).toMatchObject({
      primaryKind: 'needsInput',
      primaryCount: 1,
      stale: true,
      primaryTitle: 'Private title',
      checkedAt: retained.snapshot.updatedAt,
      canCreate: true,
      canApprove: true,
    });
    expect(props.actionFeedback).toBe('couldNotApprove');
  });

  it.each([{ signedOut: true }, { orgInvalid: true }])(
    'clears Home private content when surface flags override retained data',
    flags => {
      const retained = {
        snapshot: snapshotFor([PERMISSION_ROW]),
        details: { ...EMPTY_HOME_WIDGET_DETAILS, primaryTitle: 'Private title' },
      };
      const props = buildGlanceableViewProps(retained.snapshot, flags, translate, retained, NOW);
      expect(props.home).toMatchObject({
        primaryCount: 0,
        primaryTitle: null,
        waitingAgents: [],
        scheduledAgents: [],
        canApprove: false,
        canCreate: false,
      });
    }
  );

  it('turns a missed wake into Awaiting update without advancing the checked time', () => {
    const wake = new Date(NOW + 60_000).toISOString();
    const snapshot = snapshotFor([{ status: 'scheduled', scheduledAt: wake }]);
    const data = { snapshot, details: EMPTY_HOME_WIDGET_DETAILS };
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const props = toWidgetProps(buildGlanceableViewProps(snapshot, {}, translate, data, NOW));
    const frames = widgetTimelineFrames(snapshot, props, translate, data) ?? [];
    expect(frames.map(frame => frame.date.getTime())).toEqual(
      frames.map(frame => frame.date.getTime()).toSorted((left, right) => left - right)
    );
    const atWake = frames.find(frame => frame.date.getTime() === Date.parse(wake));
    expect(atWake?.props.home).toMatchObject({
      awaitingUpdate: true,
      primaryKind: 'scheduled',
      primaryCount: 1,
      checkedAt: snapshot.updatedAt,
    });
    const expired = frames.find(frame => frame.date.getTime() === Date.parse(snapshot.expiresAt));
    expect(expired?.props.countLines).toEqual([]);
    expect(expired?.props.home).toMatchObject({
      primaryKind: 'scheduled',
      primaryCount: 1,
      stale: true,
    });
  });

  it('omits nested nulls at the UserDefaults boundary, without deleting list entries', () => {
    const snapshot = snapshotFor([{ status: 'scheduled' }]);
    const data = {
      snapshot,
      details: {
        ...EMPTY_HOME_WIDGET_DETAILS,
        scheduledAgents: [{ title: '', scheduledAt: null }],
      },
    };
    const props = toWidgetProps(buildGlanceableViewProps(snapshot, {}, translate, data, NOW));
    expect(JSON.stringify(props)).not.toContain(':null');
    expect(props.home?.scheduledAgents).toEqual([{ title: '' }]);
  });
});

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
  type GlanceableSessionRow,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { afterEach, describe, expect, it } from 'vitest';

import { withStatus } from '@/lib/glanceable/publisher';
import { setSurfaceExtras } from '@/lib/glanceable/surface-extras';

import {
  buildGlanceableLiveActivityContentState,
  buildGlanceableViewProps,
  toWidgetProps,
} from './view-props';

const NOW = Date.parse('2026-01-02T00:00:00Z');

const COPY: Record<string, string> = {
  'glanceable.approving': 'Approving…',
  'common.starting': 'Starting…',
  'glanceable.couldNotApprove': 'Could not approve',
  'glanceable.couldNotStart': 'Could not start',
  'glanceable.newestSession': 'Newest: {{title}}',
};
const translate = (key: string): string => COPY[key] ?? key;

// The extras are module state shared by the publisher and every surface; a case
// that sets them resets them here so it cannot colour the next one.
afterEach(() => {
  setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
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
    ['starting', 'Starting…'],
    ['couldNotApprove', 'Could not approve'],
    ['couldNotStart', 'Could not start'],
  ] as const)('renders the %s action feedback on a happy surface', (feedback, expected) => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: feedback });
    const props = buildGlanceableViewProps(snapshotFor([{ status: 'question' }]), {}, translate);
    expect(props.newestTitle).toBe(expected);
  });

  it('renders a failed create in the empty surface’s reserved line', () => {
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: 'couldNotStart' });
    const props = buildGlanceableViewProps(snapshotFor([], 'empty'), {}, translate);
    expect(props.newestTitle).toBe('Could not start');
    expect(props.countLines).toEqual([]);
    expect(props.actions).toEqual({ approve: false, newAgent: true });
  });

  it('never draws the reserved line on a locked surface, even with feedback set', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: 'starting' });
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
    // Empty offers the create, so its slot carries the create's feedback; with
    // none in flight the slot is blank rather than a stale title.
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

  it('keeps New agent disabled while a permission waits', () => {
    const props = buildGlanceableViewProps(snapshotFor([PERMISSION_ROW]), {}, translate);
    expect(props.actions).toEqual({ approve: true, newAgent: false });
  });

  it.each(['question', 'retry'] as const)(
    'offers no button for a %s wait the action cannot answer',
    status => {
      // `needsInput` folds in questions and retries: a question needs an answer
      // and a retry needs the provider back, so neither may draw a button whose
      // press only finds nothing to approve and opens the app instead.
      const props = buildGlanceableViewProps(snapshotFor([{ status }]), {}, translate);
      expect(props.actions).toEqual({ approve: false, newAgent: false });
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
    const props = buildGlanceableViewProps(snapshotFor([PERMISSION_ROW]), {}, translate);
    expect(Object.keys(props).toSorted()).toEqual([
      'accessibilityLabel',
      'actions',
      'countLines',
      'needsInputSince',
      'newestResultAt',
      'newestResultKind',
      'newestResultLabel',
      'newestTitle',
      'primaryCount',
      'primaryKind',
      'primaryLabel',
      'statusLine',
    ]);
    expect('needsApproval' in props).toBe(false);
    expect(toWidgetProps(props)).not.toHaveProperty('needsApproval');
  });
});

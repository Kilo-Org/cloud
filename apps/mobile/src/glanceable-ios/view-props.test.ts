import { describe, expect, it } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
  type GlanceableSessionRow,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { withStatus } from '@/lib/glanceable/publisher';

import {
  buildGlanceableLiveActivityContentState,
  buildGlanceableViewProps,
  toWidgetProps,
} from './view-props';

const NOW = Date.parse('2026-01-02T00:00:00Z');
const CTX = { userId: 'u1', organizationId: null };

function snapshot(sessions: readonly GlanceableSessionRow[]): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({ ...CTX, sessions, now: NOW });
}

const PERMISSION_ROW: GlanceableSessionRow = {
  status: 'permission',
  statusUpdatedAt: '2026-01-01T00:00:00.000Z',
};
const QUESTION_ROW: GlanceableSessionRow = {
  status: 'question',
  statusUpdatedAt: '2026-01-01T00:00:00.000Z',
};

const translate = (key: string) => key;

/**
 * The approvable count is the gate for the Live Activity's Approve control. It
 * is narrower than `needsInput` on purpose: only a permission prompt can be
 * answered without choosing an option, so a question or a retry must never
 * raise the control.
 */
describe('buildGlanceableLiveActivityContentState needsApproval', () => {
  it('forwards one permission wait as 1', () => {
    const built = snapshot([PERMISSION_ROW]);
    expect(built.needsApproval).toBe(1);
    expect(buildGlanceableLiveActivityContentState(built).needsApproval).toBe(1);
  });

  it('forwards a question-only wait as 0, though it is still needs-input', () => {
    const built = snapshot([QUESTION_ROW]);
    expect(built.needsInput).toBe(1);
    expect(buildGlanceableLiveActivityContentState(built).needsApproval).toBe(0);
  });

  it('reads an absent field on an old snapshot as 0, never undefined', () => {
    // An older producer omits `needsApproval` from the pushed shape. The
    // content state must still carry a number: the layout compares it with
    // `> 0` and must not draw the control for a value it cannot read.
    const { needsApproval: _omitted, ...oldSnapshot } = snapshot([PERMISSION_ROW]);
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
    const current = snapshot([PERMISSION_ROW]);
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

  it('keeps the count off the widget props, which stay read-only counts', () => {
    // The Home Screen widget and the complication render `GlanceableViewProps`
    // and must never grow an approve affordance. Assert the whole key set so a
    // new field on the widget shape fails here rather than shipping on the
    // read-only surfaces.
    const props = buildGlanceableViewProps(snapshot([PERMISSION_ROW]), {}, translate);
    expect(Object.keys(props).toSorted()).toEqual([
      'accessibilityLabel',
      'countLines',
      'needsInputSince',
      'primaryCount',
      'primaryKind',
      'primaryLabel',
      'statusLine',
    ]);
    expect('needsApproval' in props).toBe(false);
    expect(toWidgetProps(props)).not.toHaveProperty('needsApproval');
  });
});

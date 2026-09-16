import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { afterEach, describe, expect, it } from 'vitest';

import { setSurfaceExtras } from '@/lib/glanceable/surface-extras';

import { buildGlanceableViewProps } from './view-props';

const NOW = 1_750_000_000_000;

const COPY: Record<string, string> = {
  'glanceable.approving': 'Approving...',
  'common.starting': 'Starting...',
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
  sessions: { status: string }[] = [],
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

describe('newestTitleFor', () => {
  it.each([
    ['approving', 'Approving...'],
    ['starting', 'Starting...'],
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

  it('keeps New agent disabled while a session waits', () => {
    const props = buildGlanceableViewProps(snapshotFor([{ status: 'question' }]), {}, translate);
    expect(props.actions).toEqual({ approve: true, newAgent: false });
  });
});

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
  type GlanceableSessionRow,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { describe, expect, it } from 'vitest';

import {
  buildOngoingNotificationContent,
  type NotificationAction,
  type NotificationFormat,
} from './ongoing-notification';

const NOW = 1_750_000_000_000;
const WAKE = new Date(NOW + 7_200_000).toISOString();
const COPY: Record<string, string> = {
  'glanceable.needsInput': 'Needs input',
  'common.working': 'Working',
  'common.scheduled': 'Scheduled',
  'common.idle': 'Idle',
  'glanceable.checked': 'Checked',
  'glanceable.lastKnown': 'Last known',
  'glanceable.nextRun': 'Next run',
  'glanceable.approving': 'Approving…',
  'glanceable.signedOut': 'Sign in to see agents',
  'glanceable.privacy': 'Open Kilo to see agents',
  'glanceable.expired': 'Status expired',
  'glanceable.waiting': 'Updating agents',
  'glanceable.empty': 'No work in progress',
};
const FORMAT: NotificationFormat = {
  translate: key => COPY[key] ?? key,
  formatCount: String,
  formatClock: at => (at === WAKE ? '6:00 PM' : '4:32 PM'),
};
const IDLE: NotificationAction = { approving: false, failure: null };

function snapshotFor(
  sessions: GlanceableSessionRow[],
  status?: GlanceableAgentsSnapshot['status']
) {
  return buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
    ...(status === undefined ? {} : { status }),
  });
}
const MIXED = snapshotFor([
  { status: 'permission' },
  { status: 'question' },
  { status: 'busy' },
  { status: 'busy' },
  { status: 'busy' },
  { status: 'scheduled', scheduledAt: WAKE },
]);

describe('ongoing notification content (round 8)', () => {
  it('titles the ranked count and lists the others with the checked time', () => {
    expect(buildOngoingNotificationContent(MIXED, FORMAT, IDLE)).toEqual({
      title: '2 Needs input',
      text: '3 Working · 1 Scheduled',
      textIsError: false,
      subText: 'Checked 4:32 PM',
      compactText: '2',
      offersNewAgent: false,
    });
  });

  it('replaces the text while approving and with the red retry line after a failure', () => {
    expect(
      buildOngoingNotificationContent(MIXED, FORMAT, { approving: true, failure: null })
    ).toMatchObject({
      title: '2 Needs input',
      text: 'Approving…',
      textIsError: false,
    });
    const failure = "Couldn't approve. Tap Approve to try again.";
    expect(
      buildOngoingNotificationContent(MIXED, FORMAT, { approving: false, failure })
    ).toMatchObject({
      text: failure,
      textIsError: true,
    });
  });

  it('offers New agent on a working card, not on a stale one', () => {
    const working = snapshotFor([{ status: 'busy' }, { status: 'busy' }, { status: 'idle' }]);
    expect(buildOngoingNotificationContent(working, FORMAT, IDLE)).toMatchObject({
      title: '2 Working',
      text: '1 Idle',
      offersNewAgent: true,
    });
    expect(
      buildOngoingNotificationContent({ ...working, status: 'stale' }, FORMAT, IDLE)
    ).toMatchObject({ subText: 'Last known · 4:32 PM', offersNewAgent: false });
  });

  it('shows the run time as text and chip when only a wake is scheduled', () => {
    const scheduled = snapshotFor([
      { status: 'scheduled', scheduledAt: WAKE },
      { status: 'scheduled', scheduledAt: new Date(NOW + 9e6).toISOString() },
    ]);
    expect(buildOngoingNotificationContent(scheduled, FORMAT, IDLE)).toMatchObject({
      title: '2 Scheduled',
      text: 'Next run 6:00 PM',
      compactText: '6:00 PM',
    });
  });

  it('keeps a question-only card to its count', () => {
    expect(
      buildOngoingNotificationContent(snapshotFor([{ status: 'question' }]), FORMAT, IDLE)
    ).toMatchObject({ title: '1 Needs input', text: '', compactText: '1' });
  });

  it.each(['signed_out', 'privacy', 'expired', 'waiting', 'empty'] as const)(
    'shows only the status line on %s',
    status => {
      const content = buildOngoingNotificationContent({ ...MIXED, status }, FORMAT, IDLE);
      expect(content).toMatchObject({
        text: '',
        subText: null,
        compactText: null,
        offersNewAgent: false,
      });
      expect(content.title).toBe(
        FORMAT.translate(
          {
            signed_out: 'glanceable.signedOut',
            privacy: 'glanceable.privacy',
            expired: 'glanceable.expired',
            waiting: 'glanceable.waiting',
            empty: 'glanceable.empty',
          }[status]
        )
      );
    }
  );
});

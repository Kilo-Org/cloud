import { describe, it, expect } from 'vitest';
import { dispatchOne, runSweepWithIO, type SweepIO } from './scheduled-action-notices';
import type { KiloClawEnv } from '../types';

type DueRow = Awaited<ReturnType<SweepIO['selectDue']>>[number];

function makeRow(overrides: Partial<DueRow> = {}): DueRow {
  return {
    notification_id: '00000000-0000-0000-0000-000000000001',
    notification_kind: 'notice',
    notification_channel: 'email',
    target_id: '00000000-0000-0000-0000-0000000000aa',
    scheduled_action_id: '00000000-0000-0000-0000-0000000000bb',
    action_type: 'scheduled_restart',
    user_id: 'user_123',
    user_record_id: 'user_123',
    user_email: 'u@example.com',
    user_name: 'User',
    instance_id: '00000000-0000-0000-0000-0000000000cc',
    instance_sandbox_id: 'ki_abc',
    instance_name: 'My Bot',
    source_image_tag: null,
    source_openclaw_version: null,
    target_image_tag: null,
    target_openclaw_version: null,
    override_pins: false,
    scheduled_at: '2026-05-04T18:55:00Z',
    notice_lead_hours: 24,
    notice_subject: 'Heads up',
    notice_body: 'Body',
    reason: null,
    ...overrides,
  };
}

type FakeIO = SweepIO & {
  calls: {
    recover: number;
    voidStale: number;
    select: number;
    claim: string[];
    sent: string[];
    failed: Array<{ id: string; err: string }>;
    dispatched: string[];
  };
};

function fakeIO(opts: {
  due: DueRow[];
  recovered?: number;
  voidedStale?: number;
  claim?: (row: DueRow) => Promise<boolean>;
  dispatch?: (row: DueRow) => Promise<{ ok: true } | { ok: false; error: string }>;
  markSent?: (row: DueRow) => Promise<void>;
  markFailed?: (id: string, err: string) => Promise<void>;
}): FakeIO {
  const calls = {
    recover: 0,
    voidStale: 0,
    select: 0,
    claim: [] as string[],
    sent: [] as string[],
    failed: [] as Array<{ id: string; err: string }>,
    dispatched: [] as string[],
  };
  return {
    calls,
    recoverStuckClaims: async () => {
      calls.recover += 1;
      return opts.recovered ?? 0;
    },
    voidStaleParents: async () => {
      calls.voidStale += 1;
      return opts.voidedStale ?? 0;
    },
    selectDue: async () => {
      calls.select += 1;
      return opts.due;
    },
    claim: async row => {
      calls.claim.push(row.notification_id);
      return opts.claim ? opts.claim(row) : true;
    },
    dispatchOne: async row => {
      calls.dispatched.push(row.notification_id);
      return opts.dispatch ? opts.dispatch(row) : { ok: true };
    },
    markSent: async row => {
      if (opts.markSent) {
        await opts.markSent(row);
      }
      calls.sent.push(row.notification_id);
    },
    markFailed: async (id, err) => {
      if (opts.markFailed) {
        await opts.markFailed(id, err);
      }
      calls.failed.push({ id, err });
    },
  };
}

describe('runSweepWithIO', () => {
  it('returns zeros and skips dispatch when no rows are due, but still runs recovery + voidStale', async () => {
    const io = fakeIO({ due: [], recovered: 3, voidedStale: 2 });
    const result = await runSweepWithIO(io);
    expect(result).toEqual({ processed: 0, sent: 0, failed: 0, recovered: 3, voidedStale: 2 });
    expect(io.calls.recover).toBe(1);
    expect(io.calls.voidStale).toBe(1);
    expect(io.calls.select).toBe(1);
    expect(io.calls.claim).toEqual([]);
    expect(io.calls.dispatched).toEqual([]);
  });

  it('claims, dispatches, and marks each row sent on the happy path', async () => {
    const due = [makeRow({ notification_id: 'n-1' }), makeRow({ notification_id: 'n-2' })];
    const io = fakeIO({ due });
    const result = await runSweepWithIO(io);
    expect(result).toEqual({ processed: 2, sent: 2, failed: 0, recovered: 0, voidedStale: 0 });
    expect(io.calls.claim).toEqual(['n-1', 'n-2']);
    expect(io.calls.dispatched).toEqual(['n-1', 'n-2']);
    expect(io.calls.sent).toEqual(['n-1', 'n-2']);
    expect(io.calls.failed).toEqual([]);
  });

  it('skips a row when claim() returns false (already-claimed by another tick)', async () => {
    const due = [makeRow({ notification_id: 'lost' })];
    const io = fakeIO({
      due,
      claim: async () => false,
    });
    const result = await runSweepWithIO(io);
    expect(result).toEqual({ processed: 1, sent: 0, failed: 0, recovered: 0, voidedStale: 0 });
    expect(io.calls.dispatched).toEqual([]); // never dispatched
    expect(io.calls.sent).toEqual([]);
    expect(io.calls.failed).toEqual([]);
  });

  it('skips dispatch when parent state changed between selectDue and claim (apply-race)', async () => {
    // Simulates the TOCTOU window: selectDue picked a notice while
    // target.status was still 'pending', but the apply path moved it
    // to 'running' before our claim CAS. The real claim's EXISTS gate
    // returns false; the fake mirrors that. Dispatch must NOT fire.
    const due = [makeRow({ notification_id: 'apply-race', notification_kind: 'notice' })];
    const io = fakeIO({
      due,
      claim: async row => {
        // Notice for a target that already moved → claim fails.
        return row.notification_kind !== 'notice';
      },
    });
    const result = await runSweepWithIO(io);
    expect(result).toEqual({ processed: 1, sent: 0, failed: 0, recovered: 0, voidedStale: 0 });
    expect(io.calls.dispatched).toEqual([]);
    expect(io.calls.sent).toEqual([]);
    expect(io.calls.failed).toEqual([]);
  });

  it('still dispatches cancelled rows when claim guard would block notices', async () => {
    // 'cancelled' rows must fire regardless of parent state — they
    // announce that the previously-noticed action is now off, even if
    // the action already moved to applied/skipped/failed in the
    // interim. The real claim's parentStateGate evaluates to true for
    // kind='cancelled'; the fake mirrors that distinction.
    const due = [
      makeRow({ notification_id: 'notice-blocked', notification_kind: 'notice' }),
      makeRow({ notification_id: 'cancel-fires', notification_kind: 'cancelled' }),
    ];
    const io = fakeIO({
      due,
      claim: async row => row.notification_kind === 'cancelled',
    });
    const result = await runSweepWithIO(io);
    expect(result).toEqual({ processed: 2, sent: 1, failed: 0, recovered: 0, voidedStale: 0 });
    expect(io.calls.dispatched).toEqual(['cancel-fires']);
    expect(io.calls.sent).toEqual(['cancel-fires']);
  });

  it('marks failed when dispatchOne reports ok:false', async () => {
    const due = [makeRow({ notification_id: 'bad' })];
    const io = fakeIO({
      due,
      dispatch: async () => ({ ok: false, error: 'agent channel not implemented' }),
    });
    const result = await runSweepWithIO(io);
    expect(result).toEqual({ processed: 1, sent: 0, failed: 1, recovered: 0, voidedStale: 0 });
    expect(io.calls.failed).toEqual([{ id: 'bad', err: 'agent channel not implemented' }]);
    expect(io.calls.sent).toEqual([]);
  });

  it('counts a row as failed when markSent throws (final transition fails)', async () => {
    const due = [makeRow({ notification_id: 'mark-throws' })];
    const io = fakeIO({
      due,
      markSent: async () => {
        throw new Error('connection reset');
      },
    });
    const result = await runSweepWithIO(io);
    expect(result.processed).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    // dispatchOne was called; markSent was attempted (and threw before push)
    expect(io.calls.dispatched).toEqual(['mark-throws']);
    expect(io.calls.sent).toEqual([]);
  });

  it('does not abort the batch when one row fails — siblings still process', async () => {
    const due = [
      makeRow({ notification_id: 'good-1' }),
      makeRow({ notification_id: 'bad', notification_channel: 'agent' }),
      makeRow({ notification_id: 'good-2' }),
    ];
    const io = fakeIO({
      due,
      dispatch: async row => {
        if (row.notification_channel === 'agent') {
          return { ok: false, error: 'agent channel not implemented' };
        }
        return { ok: true };
      },
    });
    const result = await runSweepWithIO(io);
    expect(result).toEqual({ processed: 3, sent: 2, failed: 1, recovered: 0, voidedStale: 0 });
    expect(io.calls.sent).toEqual(['good-1', 'good-2']);
    expect(io.calls.failed.map(f => f.id)).toEqual(['bad']);
  });

  it('reports recovered + voidedStale counts even when due rows process normally', async () => {
    const due = [makeRow({ notification_id: 'n-1' })];
    const io = fakeIO({ due, recovered: 2, voidedStale: 1 });
    const result = await runSweepWithIO(io);
    expect(result).toEqual({ processed: 1, sent: 1, failed: 0, recovered: 2, voidedStale: 1 });
  });
});

describe('dispatchOne orphan-user guard', () => {
  // The leftJoin on kilocode_users is what surfaces these rows; without
  // the dispatchOne pre-check they would loop forever in 'pending'
  // because no channel can succeed. env is not accessed when the guard
  // trips, so a minimal cast is enough.
  const fakeEnv = {} as KiloClawEnv;

  it('returns ok:false for every channel when user_record_id is null', async () => {
    const channels = ['email', 'webapp', 'mobile_push', 'agent'] as const;
    for (const channel of channels) {
      const row = {
        notification_id: 'n-1',
        notification_kind: 'notice' as const,
        notification_channel: channel,
        target_id: '00000000-0000-0000-0000-0000000000aa',
        scheduled_action_id: '00000000-0000-0000-0000-0000000000bb',
        action_type: 'scheduled_restart' as const,
        user_id: 'orphan_user',
        user_record_id: null,
        user_email: null,
        user_name: null,
        instance_id: '00000000-0000-0000-0000-0000000000cc',
        instance_sandbox_id: 'ki_abc',
        instance_name: 'My Bot',
        source_image_tag: null,
        source_openclaw_version: null,
        target_image_tag: null,
        target_openclaw_version: null,
        override_pins: false,
        scheduled_at: '2026-05-04T18:55:00Z',
        notice_lead_hours: 24,
        notice_subject: 'Heads up',
        notice_body: 'Body',
        reason: null,
      } satisfies DueRow;

      const result = await dispatchOne(fakeEnv, row);
      expect(result).toEqual({
        ok: false,
        error: 'kilocode_users row missing for user_id=orphan_user',
      });
    }
  });

  it('webapp channel still no-ops when user_record_id is present', async () => {
    const row = {
      notification_id: 'n-2',
      notification_kind: 'notice' as const,
      notification_channel: 'webapp' as const,
      target_id: '00000000-0000-0000-0000-0000000000aa',
      scheduled_action_id: '00000000-0000-0000-0000-0000000000bb',
      action_type: 'scheduled_restart' as const,
      user_id: 'user_present',
      user_record_id: 'user_present',
      user_email: null,
      user_name: null,
      instance_id: '00000000-0000-0000-0000-0000000000cc',
      instance_sandbox_id: 'ki_abc',
      instance_name: 'My Bot',
      source_image_tag: null,
      source_openclaw_version: null,
      target_image_tag: null,
      target_openclaw_version: null,
      override_pins: false,
      scheduled_at: '2026-05-04T18:55:00Z',
      notice_lead_hours: 24,
      notice_subject: 'Heads up',
      notice_body: 'Body',
      reason: null,
    } satisfies DueRow;

    const result = await dispatchOne(fakeEnv, row);
    expect(result).toEqual({ ok: true });
  });
});

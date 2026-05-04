import { describe, it, expect } from 'vitest';
import { runSweepWithIO, type SweepIO } from './scheduled-action-notices';

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
  claim?: (id: string) => Promise<boolean>;
  dispatch?: (row: DueRow) => Promise<{ ok: true } | { ok: false; error: string }>;
  markSent?: (id: string) => Promise<void>;
  markFailed?: (id: string, err: string) => Promise<void>;
}): FakeIO {
  const calls = {
    recover: 0,
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
    selectDue: async () => {
      calls.select += 1;
      return opts.due;
    },
    claim: async id => {
      calls.claim.push(id);
      return opts.claim ? opts.claim(id) : true;
    },
    dispatchOne: async row => {
      calls.dispatched.push(row.notification_id);
      return opts.dispatch ? opts.dispatch(row) : { ok: true };
    },
    markSent: async id => {
      if (opts.markSent) {
        await opts.markSent(id);
      }
      calls.sent.push(id);
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
  it('returns zeros and skips dispatch when no rows are due, but still runs recovery', async () => {
    const io = fakeIO({ due: [], recovered: 3 });
    const result = await runSweepWithIO(io);
    expect(result).toEqual({ processed: 0, sent: 0, failed: 0, recovered: 3 });
    expect(io.calls.recover).toBe(1);
    expect(io.calls.select).toBe(1);
    expect(io.calls.claim).toEqual([]);
    expect(io.calls.dispatched).toEqual([]);
  });

  it('claims, dispatches, and marks each row sent on the happy path', async () => {
    const due = [makeRow({ notification_id: 'n-1' }), makeRow({ notification_id: 'n-2' })];
    const io = fakeIO({ due });
    const result = await runSweepWithIO(io);
    expect(result).toEqual({ processed: 2, sent: 2, failed: 0, recovered: 0 });
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
    expect(result).toEqual({ processed: 1, sent: 0, failed: 0, recovered: 0 });
    expect(io.calls.dispatched).toEqual([]); // never dispatched
    expect(io.calls.sent).toEqual([]);
    expect(io.calls.failed).toEqual([]);
  });

  it('marks failed when dispatchOne reports ok:false', async () => {
    const due = [makeRow({ notification_id: 'bad' })];
    const io = fakeIO({
      due,
      dispatch: async () => ({ ok: false, error: 'agent channel not implemented' }),
    });
    const result = await runSweepWithIO(io);
    expect(result).toEqual({ processed: 1, sent: 0, failed: 1, recovered: 0 });
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
    expect(result).toEqual({ processed: 3, sent: 2, failed: 1, recovered: 0 });
    expect(io.calls.sent).toEqual(['good-1', 'good-2']);
    expect(io.calls.failed.map(f => f.id)).toEqual(['bad']);
  });

  it('reports recovered count from recoverStuckClaims even when due rows process normally', async () => {
    const due = [makeRow({ notification_id: 'n-1' })];
    const io = fakeIO({ due, recovered: 2 });
    const result = await runSweepWithIO(io);
    expect(result).toEqual({ processed: 1, sent: 1, failed: 0, recovered: 2 });
  });
});

import { describe, expect, it } from 'vitest';
import {
  DenialBuffer,
  MAX_ISOLATE_DISTINCT_PER_MINUTE,
  type Denial,
  type DenialCount,
} from '../../src/audit/denials';

function replayed(ref: string): Denial {
  return {
    channel: 'http',
    reason: 'unknown_workload',
    actor: 'github:999',
    claims: { provider: 'github', repository_id: '999', ref },
  };
}

const FIRST = '2026-11-25T12:00';
const SECOND = '2026-11-25T12:01';

function buffer() {
  let clock = Date.parse('2026-11-25T12:00:10.000Z');
  let failing = false;
  const sent: DenialCount[][] = [];
  const failed: DenialCount[][] = [];
  const instance = new DenialBuffer(
    async counts => {
      if (failing) {
        failed.push(counts.map(count => ({ ...count })));
        throw new Error('denial object unavailable');
      }
      sent.push(counts.map(count => ({ ...count })));
    },
    () => clock
  );
  return {
    add: (denial: Denial) => instance.add(denial),
    sent,
    failed,
    fail: (value: boolean) => {
      failing = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('isolate denial buffer', () => {
  it('sends one record per distinct denial per minute and counts the replays', async () => {
    const subject = buffer();
    const hops = Array.from({ length: 50 }, () => subject.add(replayed('refs/heads/main')));
    const sentHops = hops.filter((hop): hop is Promise<void> => hop !== null);
    expect(sentHops).toHaveLength(1);
    await Promise.all(sentHops);
    expect(subject.sent).toEqual([
      [{ denial: replayed('refs/heads/main'), count: 1, overflow: false, minute: FIRST }],
    ]);

    subject.advance(60_000);
    await subject.add(replayed('refs/heads/other'));
    expect(subject.sent[1]).toEqual([
      { denial: replayed('refs/heads/main'), count: 49, overflow: false, minute: FIRST },
      { denial: replayed('refs/heads/other'), count: 1, overflow: false, minute: SECOND },
    ]);
  });

  it('carries ended counts on the next hop even when the new denial is a repeat', async () => {
    const subject = buffer();
    await subject.add(replayed('refs/heads/main'));
    expect(subject.add(replayed('refs/heads/main'))).toBeNull();
    subject.advance(60_000);
    await subject.add(replayed('refs/heads/main'));
    expect(subject.sent[1]).toEqual([
      { denial: replayed('refs/heads/main'), count: 1, overflow: false, minute: FIRST },
      { denial: replayed('refs/heads/main'), count: 1, overflow: false, minute: SECOND },
    ]);
  });

  it('counts distinct denials past the isolate limit as one overflow record per reason', async () => {
    const subject = buffer();
    for (let index = 0; index < MAX_ISOLATE_DISTINCT_PER_MINUTE + 10; index += 1) {
      await subject.add(replayed(`refs/heads/branch-${index}`));
    }
    expect(subject.sent).toHaveLength(MAX_ISOLATE_DISTINCT_PER_MINUTE + 1);
    expect(subject.sent.at(-1)).toEqual([
      {
        denial: { channel: 'http', reason: 'unknown_workload', actor: 'overflow', claims: {} },
        count: 1,
        overflow: true,
        minute: FIRST,
      },
    ]);
    subject.advance(60_000);
    await subject.add(replayed('refs/heads/next'));
    const ended = subject.sent.at(-1)?.find(entry => entry.overflow);
    expect(ended?.count).toBe(9);
  });

  it('sends again on the next occurrence after a failed first send, with the lost count', async () => {
    const subject = buffer();
    subject.fail(true);
    await subject.add(replayed('refs/heads/main'));
    expect(subject.failed).toHaveLength(1);
    subject.fail(false);
    subject.advance(10_000);

    const retried = subject.add(replayed('refs/heads/main'));
    expect(retried).not.toBeNull();
    await retried;
    expect(subject.sent).toEqual([
      [{ denial: replayed('refs/heads/main'), count: 2, overflow: false, minute: FIRST }],
    ]);
    expect(subject.add(replayed('refs/heads/main'))).toBeNull();
  });

  it('keeps ended counts from a failed send for the next hop, with their own minute', async () => {
    const subject = buffer();
    await subject.add(replayed('refs/heads/main'));
    expect(subject.add(replayed('refs/heads/main'))).toBeNull();
    expect(subject.add(replayed('refs/heads/main'))).toBeNull();
    subject.advance(60_000);
    subject.fail(true);
    await subject.add(replayed('refs/heads/other'));
    subject.fail(false);
    subject.advance(10_000);

    await subject.add(replayed('refs/heads/third'));
    expect(subject.sent.at(-1)).toEqual([
      { denial: replayed('refs/heads/main'), count: 2, overflow: false, minute: FIRST },
      { denial: replayed('refs/heads/other'), count: 1, overflow: false, minute: SECOND },
      { denial: replayed('refs/heads/third'), count: 1, overflow: false, minute: SECOND },
    ]);
  });

  it('only counts during a backoff after a failed send, then sends everything once', async () => {
    const subject = buffer();
    subject.fail(true);
    await subject.add(replayed('refs/heads/a'));
    for (let index = 0; index < 20; index += 1) {
      expect(subject.add(replayed(`refs/heads/held-${index % 4}`))).toBeNull();
    }
    subject.advance(9_000);
    expect(subject.add(replayed('refs/heads/a'))).toBeNull();
    expect(subject.failed).toHaveLength(1);

    subject.advance(1_000);
    await subject.add(replayed('refs/heads/a'));
    expect(subject.failed).toHaveLength(2);
    expect(subject.failed[1].map(count => count.count).sort()).toEqual([3, 5, 5, 5, 5]);

    subject.fail(false);
    subject.advance(19_000);
    expect(subject.add(replayed('refs/heads/a'))).toBeNull();
    subject.advance(1_000);
    await subject.add(replayed('refs/heads/a'));
    expect(subject.sent).toHaveLength(1);
    expect(subject.sent[0].reduce((total, count) => total + count.count, 0)).toBe(25);

    await subject.add(replayed('refs/heads/fresh'));
    expect(subject.sent).toHaveLength(2);
  });

  it('doubles the backoff per failure up to one minute', async () => {
    const subject = buffer();
    subject.fail(true);
    const holds: number[] = [];
    await subject.add(replayed('refs/heads/start'));
    for (let failure = 0; failure < 6; failure += 1) {
      let waited = 0;
      for (;;) {
        subject.advance(1_000);
        waited += 1_000;
        const hop = subject.add(replayed('refs/heads/start'));
        if (hop !== null) {
          await hop;
          break;
        }
      }
      holds.push(waited);
    }
    expect(holds).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });
});

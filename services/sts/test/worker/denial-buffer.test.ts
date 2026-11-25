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

function buffer() {
  let clock = Date.parse('2026-11-25T12:00:10.000Z');
  const sent: DenialCount[][] = [];
  const instance = new DenialBuffer(
    async counts => {
      sent.push(counts);
    },
    () => clock
  );
  return {
    add: (denial: Denial) => instance.add(denial),
    sent,
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
      [{ denial: replayed('refs/heads/main'), count: 1, overflow: false }],
    ]);

    subject.advance(60_000);
    await subject.add(replayed('refs/heads/other'));
    expect(subject.sent[1]).toEqual([
      { denial: replayed('refs/heads/main'), count: 49, overflow: false },
      { denial: replayed('refs/heads/other'), count: 1, overflow: false },
    ]);
  });

  it('carries ended counts on the next hop even when the new denial is a repeat', async () => {
    const subject = buffer();
    await subject.add(replayed('refs/heads/main'));
    expect(subject.add(replayed('refs/heads/main'))).toBeNull();
    subject.advance(60_000);
    await subject.add(replayed('refs/heads/main'));
    expect(subject.sent[1]).toEqual([
      { denial: replayed('refs/heads/main'), count: 1, overflow: false },
      { denial: replayed('refs/heads/main'), count: 1, overflow: false },
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
      },
    ]);
    subject.advance(60_000);
    await subject.add(replayed('refs/heads/next'));
    const ended = subject.sent.at(-1)?.find(entry => entry.overflow);
    expect(ended?.count).toBe(9);
  });
});

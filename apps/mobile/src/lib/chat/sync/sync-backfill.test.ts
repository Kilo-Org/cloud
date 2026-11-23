import { describe, expect, it, vi } from 'vitest';

import { runBackfill } from './sync-backfill';
import  { type UploadOutcome } from './sync-engine';

/**
 * Backfill under upgrade: existing chats upload in the background, one at a
 * time, and turning sync off stops every further request while the chats it
 * already uploaded stay synced.
 */

const make = (script: {
  chats: string[];
  outcomes: Record<string, UploadOutcome[]>;
  on?: () => Promise<boolean>;
}) => {
  const requested: string[] = [];
  const waits: number[] = [];
  let on = true;
  const stillOn = vi.fn(async () => script.on?.() ?? on);
  const result = () =>
    runBackfill({
      pending: () => script.chats,
      upload: async sessionId => {
        requested.push(sessionId);
        const queue = script.outcomes[sessionId] ?? [{ kind: 'synced', position: 1 }];
        return queue.shift() ?? { kind: 'synced', position: 1 };
      },
      stillOn,
      wait: async ms => {
        waits.push(ms);
      },
    });
  return {
    result,
    requested,
    waits,
    turnOff: () => {
      on = false;
    },
    stillOn,
  };
};

describe('runBackfill', () => {
  it('uploads every existing chat, one request at a time', async () => {
    const run = make({ chats: ['a', 'b', 'c'], outcomes: {} });
    expect(await run.result()).toEqual({ kind: 'done', uploaded: 3 });
    expect(run.requested).toEqual(['a', 'b', 'c']);
  });

  it('retries one chat with growing delays, then parks instead of spinning', async () => {
    const run = make({
      chats: ['a', 'b'],
      outcomes: { a: [{ kind: 'pending' }, { kind: 'pending' }, { kind: 'pending' }] },
    });
    expect(await run.result()).toEqual({ kind: 'parked', uploaded: 0 });
    expect(run.requested).toEqual(['a', 'a', 'a']);
    expect(run.waits).toEqual([2000, 4000]);
  });

  it('stops before the next request once sync is off, leaving the rest local', async () => {
    const run = make({ chats: ['a', 'b', 'c'], outcomes: {} });
    run.stillOn.mockImplementation(async () => run.requested.length === 0);
    expect(await run.result()).toEqual({ kind: 'stopped', uploaded: 1 });
    expect(run.requested).toEqual(['a']);
  });

  it('leaves a chat a retry cannot fix alone and carries on', async () => {
    const run = make({
      chats: ['gone', 'fine'],
      outcomes: { gone: [{ kind: 'deleted' }] },
    });
    expect(await run.result()).toEqual({ kind: 'done', uploaded: 1 });
    expect(run.requested).toEqual(['gone', 'fine']);
  });
});

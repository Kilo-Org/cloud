import { describe, expect, it } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { withControlPlaneReadBudget } from './control-plane-read-budget';

/** A read that never settles, so only the budget can end it. */
function stalled<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

describe('withControlPlaneReadBudget', () => {
  it('answers a mobile caller retryably when its procedure budget is spent', async () => {
    let readCalls = 0;
    const read = async () => {
      readCalls += 1;
      return 'unreachable';
    };

    await expect(
      withControlPlaneReadBudget({
        clock: { controlPlaneStartedAt: performance.now() - 9_900 },
        message: 'too slow',
        read,
      })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'too slow' });

    expect(readCalls).toBe(0);
  });

  it('answers a mobile caller retryably and aborts the read when it outlives the budget', async () => {
    let readSignal: AbortSignal | undefined;

    const outcome = withControlPlaneReadBudget({
      clock: { controlPlaneStartedAt: performance.now() - 7_950 },
      message: 'too slow',
      read: signal => {
        readSignal = signal;
        return stalled<string>();
      },
    });

    await expect(outcome).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'too slow',
    });
    expect(readSignal?.aborted).toBe(true);
  });

  it('leaves a caller with no mobile budget unbounded', async () => {
    await expect(
      withControlPlaneReadBudget({
        clock: {},
        message: 'too slow',
        read: async signal => (signal.aborted ? 'aborted' : 'answer'),
      })
    ).resolves.toBe('answer');
  });

  it('keeps a read failure that is not the deadline unchanged', async () => {
    const failure = new TRPCError({ code: 'NOT_FOUND', message: 'gone' });

    await expect(
      withControlPlaneReadBudget({
        clock: { controlPlaneStartedAt: performance.now() },
        message: 'too slow',
        read: async () => {
          throw failure;
        },
      })
    ).rejects.toBe(failure);
  });
});

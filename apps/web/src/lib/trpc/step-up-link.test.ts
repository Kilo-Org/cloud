import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { observable } from '@trpc/server/observable';
import { registerStepUpHandler, stepUpLink } from './step-up-link';

type Outcome = { nextCalls: number; error: unknown; value: unknown };

async function runOperation(
  error: unknown,
  succeedOnRetry = false,
  path = 'admin.test'
): Promise<Outcome> {
  let nextCalls = 0;
  const op = { path };
  const next = () =>
    observable(subscriber => {
      nextCalls += 1;
      if (nextCalls === 1 || !succeedOnRetry) {
        subscriber.error(error);
        return;
      }
      subscriber.next({ result: { data: 'ok' } } as never);
      subscriber.complete();
    });

  const operationLink = stepUpLink()({} as never);
  const link = operationLink({ op: op as never, next: next as never });

  return new Promise(resolve => {
    let value: unknown;
    link.subscribe({
      next: nextValue => {
        value = nextValue;
      },
      error: failure => {
        resolve({ nextCalls, error: failure, value });
      },
      complete: () => resolve({ nextCalls, error: undefined, value }),
    });
  });
}

const stepUpError = { data: { stepUp: { code: 'MFA_REQUIRED' } } };

afterEach(() => {
  registerStepUpHandler(null);
  jest.restoreAllMocks();
});

describe('stepUpLink', () => {
  it('opens verification and retries the operation exactly once', async () => {
    const handler = jest.fn(async (_requirement: unknown) => true);
    registerStepUpHandler(handler);

    const outcome = await runOperation(stepUpError, true);

    expect(outcome.nextCalls).toBe(2);
    expect(outcome.value).toEqual({ result: { data: 'ok' } });
    expect(handler).toHaveBeenCalledWith({ code: 'MFA_REQUIRED' });
  });

  it('surfaces the original error when verification is cancelled', async () => {
    const handler = jest.fn(async (_requirement: unknown) => false);
    registerStepUpHandler(handler);

    const outcome = await runOperation(stepUpError, true);

    expect(outcome.nextCalls).toBe(1);
    expect(outcome.error).toBe(stepUpError);
    expect(handler).toHaveBeenCalled();
  });

  it('does not open verification for a bearer refusal', async () => {
    const handler = jest.fn(async (_requirement: unknown) => true);
    registerStepUpHandler(handler);
    const bearerError = { data: { stepUp: { code: 'BEARER_NOT_ALLOWED' } } };

    const outcome = await runOperation(bearerError, true);

    expect(outcome.nextCalls).toBe(1);
    expect(outcome.error).toBe(bearerError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not retry more than once', async () => {
    const handler = jest.fn(async (_requirement: unknown) => true);
    registerStepUpHandler(handler);

    const outcome = await runOperation(stepUpError, false);

    expect(outcome.nextCalls).toBe(2);
    expect(outcome.error).toBe(stepUpError);
  });

  it('never handles stepUp.* operations', async () => {
    const handler = jest.fn(async (_requirement: unknown) => true);
    registerStepUpHandler(handler);

    const outcome = await runOperation(stepUpError, true, 'stepUp.getStatus');

    expect(outcome.nextCalls).toBe(1);
    expect(handler).not.toHaveBeenCalled();
  });
});

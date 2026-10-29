import { describe, expect, it } from 'bun:test';
import { createStepBudget } from './step-budget.js';

function clock() {
  let time = 0;
  return { now: () => time, advance: (ms: number) => void (time += ms) };
}

describe('createStepBudget', () => {
  it('gives the next operation what the earlier ones left', async () => {
    const time = clock();
    const budget = createStepBudget(600, time.now);
    const seen: number[] = [];

    await budget.spend(async remainingMs => {
      seen.push(remainingMs);
      time.advance(400);
    });
    await budget.spend(async remainingMs => {
      seen.push(remainingMs);
      time.advance(100);
    });
    await budget.spend(async remainingMs => {
      seen.push(remainingMs);
    });

    expect(seen).toEqual([600, 200, 100]);
  });

  it('deducts the time of an operation that fails', async () => {
    const time = clock();
    const budget = createStepBudget(600, time.now);

    const failed = await budget
      .spend(async () => {
        time.advance(350);
        throw new Error('clone failed');
      })
      .then(
        () => undefined,
        (error: Error) => error.message
      );
    expect(failed).toBe('clone failed');

    expect(await budget.spend(async remainingMs => remainingMs)).toBe(250);
  });

  it('gives zero, never a negative allowance, once it is exhausted', async () => {
    const time = clock();
    const budget = createStepBudget(600, time.now);
    await budget.spend(async () => time.advance(900));

    expect(await budget.spend(async remainingMs => remainingMs)).toBe(0);
  });

  it('returns the result of the operation', async () => {
    expect(await createStepBudget(10).spend(async () => 'done')).toBe('done');
  });
});

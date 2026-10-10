import { describe, expect, it } from 'bun:test';
import {
  beginPause,
  endPause,
  pausedMs,
  restartPauses,
  type ExecutionPauses,
} from './execution-clock.js';

function clock(): ExecutionPauses {
  return { pausedMs: 0 };
}

describe('execution clock pauses', () => {
  it('counts a memory hold that overlaps a user wait once', () => {
    const execution = clock();
    beginPause(execution, 'waitingSince', 100);
    beginPause(execution, 'heldSince', 300);
    endPause(execution, 'waitingSince', 500);
    expect(pausedMs(execution, 700)).toBe(600);
    endPause(execution, 'heldSince', 800);
    expect(execution.pausedMs).toBe(700);
    expect(pausedMs(execution, 1_000)).toBe(700);
  });

  it('credits nothing extra for a hold inside a longer user wait', () => {
    const execution = clock();
    beginPause(execution, 'waitingSince', 100);
    beginPause(execution, 'heldSince', 200);
    endPause(execution, 'heldSince', 400);
    endPause(execution, 'waitingSince', 600);
    expect(execution.pausedMs).toBe(500);
  });

  it('restarts open pauses at progress so earlier pause time is not spent again', () => {
    const execution = clock();
    beginPause(execution, 'heldSince', 100);
    restartPauses(execution, 500);
    expect(execution).toMatchObject({ pausedMs: 0, heldSince: 500 });
    expect(pausedMs(execution, 900)).toBe(400);
  });
});

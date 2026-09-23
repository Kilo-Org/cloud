import { describe, expect, it } from 'vitest';
import {
  TRANSITION_LOG_MAX_AGE_MS,
  TRANSITION_LOG_MAX_ROWS,
  appendTransition,
  emptyTransitionLog,
  sessionStateTransition,
  trimTransitionLog,
  type TransitionRow,
} from './transition-log.js';

describe('transition log', () => {
  it('appends rows in order', () => {
    const row = {
      at: 10,
      kind: 'physical',
      from: 'stopped',
      to: 'creating',
      cause: 'demand',
      providerRef: null,
    } satisfies TransitionRow;
    expect(appendTransition(emptyTransitionLog(), row)).toEqual([row]);
  });

  it('trims by row cap as a ring buffer', () => {
    let log = emptyTransitionLog();
    for (let i = 0; i < TRANSITION_LOG_MAX_ROWS + 5; i++) {
      log = appendTransition(log, {
        at: i,
        kind: 'physical',
        from: 'stopped',
        to: 'creating',
        cause: 'demand',
        providerRef: null,
      } satisfies TransitionRow);
    }
    expect(log).toHaveLength(TRANSITION_LOG_MAX_ROWS);
    expect(log[0]?.at).toBe(5);
    expect(log.at(-1)?.at).toBe(TRANSITION_LOG_MAX_ROWS + 4);
  });

  it('trims by age cap', () => {
    const now = TRANSITION_LOG_MAX_AGE_MS + 50;
    const log = trimTransitionLog(
      [
        {
          at: 0,
          kind: 'physical',
          from: 'stopped',
          to: 'creating',
          cause: 'demand',
          providerRef: null,
        } satisfies TransitionRow,
        {
          at: now,
          kind: 'physical',
          from: 'creating',
          to: 'running',
          cause: 'confirmed',
          providerRef: 'ref_1',
        } satisfies TransitionRow,
      ],
      now
    );
    expect(log).toHaveLength(1);
    expect(log[0]?.to).toBe('running');
  });

  it('does not record prompt, payload, env, or credential fields', () => {
    const row = sessionStateTransition(1, 'kilo_1', 'idle', 'active');
    expect(row).not.toHaveProperty('prompt');
    expect(row).not.toHaveProperty('payload');
    expect(row).not.toHaveProperty('credential');
    expect(row).not.toHaveProperty('env');
    expect(JSON.stringify(row)).not.toMatch(/prompt|credential|KILOCODE_TOKEN/i);
  });
});

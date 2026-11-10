import { beforeEach, describe, expect, it } from 'vitest';

import { forgetCallResults, mcpCallResultOf, rememberCallResult } from './remote-mcp-call-results';

/**
 * The answers kept for the rows that draw them: the newest is what a row asks
 * for, and nothing keeps a server's payload after its row is long gone.
 */

const answered = (callId: string, text: string) => ({
  tool: 'chart',
  callId,
  content: [{ type: 'text' as const, text }],
  structuredContent: undefined,
});

beforeEach(() => {
  forgetCallResults();
});

describe('the answers kept for a view', () => {
  it('keeps what a row asks for and drops the rest', () => {
    rememberCallResult(answered('call_1', 'one'));
    rememberCallResult(answered('call_2', 'two'));

    expect(mcpCallResultOf('call_2')?.callId).toBe('call_2');
    expect(mcpCallResultOf('call_1')?.callId).toBe('call_1');

    forgetCallResults();
    expect(mcpCallResultOf('call_1')).toBeUndefined();
  });

  it('keeps the newest answers, not an unbounded history', () => {
    for (let index = 0; index < 60; index += 1) {
      rememberCallResult(answered(`call_${String(index)}`, 'answer'));
    }

    expect(mcpCallResultOf('call_59')).toBeDefined();
    expect(mcpCallResultOf('call_0')).toBeUndefined();
  });

  it('keeps what fits and drops the oldest, so the size bound holds', () => {
    rememberCallResult(answered('call_old', 'x'.repeat(900_000)));
    rememberCallResult(answered('call_new', 'y'.repeat(900_000)));

    expect(mcpCallResultOf('call_new')).toBeDefined();
    expect(mcpCallResultOf('call_old')).toBeUndefined();
  });

  it('does not keep an answer that is over the bound on its own', () => {
    rememberCallResult(answered('call_kept', 'small'));
    rememberCallResult(answered('call_huge', 'x'.repeat(1_200_000)));

    expect(mcpCallResultOf('call_huge')).toBeUndefined();
    expect(mcpCallResultOf('call_kept')).toBeDefined();
  });
});

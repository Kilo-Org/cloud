import { describe, expect, it } from 'vitest';
import { WastelandRpcBrowseWantedBoardInput } from './schemas';

const WASTELAND_ID = '6d86793c-8c50-44b7-8da9-df0c7d2f4d0b';

describe('WastelandRpcBrowseWantedBoardInput', () => {
  it('accepts and normalizes valid browse filters', () => {
    const parsed = WastelandRpcBrowseWantedBoardInput.parse({
      wastelandId: WASTELAND_ID,
      userId: 'user-1',
      status: 'in_review',
      search: ' Bug ',
      sort: 'activity',
      limit: 500,
      includeForkBranches: true,
    });

    expect(parsed.search).toBe('Bug');
    expect(parsed.status).toBe('in_review');
    expect(parsed.limit).toBe(500);
    expect(parsed.includeForkBranches).toBe(true);
  });

  it('rejects malformed or unbounded browse filters', () => {
    expect(() =>
      WastelandRpcBrowseWantedBoardInput.parse({
        wastelandId: WASTELAND_ID,
        userId: 'user-1',
        status: 'done',
      })
    ).toThrow();

    expect(() =>
      WastelandRpcBrowseWantedBoardInput.parse({
        wastelandId: WASTELAND_ID,
        userId: 'user-1',
        limit: 501,
      })
    ).toThrow();

    expect(() =>
      WastelandRpcBrowseWantedBoardInput.parse({
        wastelandId: WASTELAND_ID,
        userId: 'user-1',
        search: ' ',
      })
    ).toThrow();
  });
});

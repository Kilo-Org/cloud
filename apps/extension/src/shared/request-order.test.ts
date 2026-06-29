import { describe, expect, it } from 'vitest';
import { isLatestRequest } from './request-order';

describe('request ordering', () => {
  it('rejects stale request results', () => {
    expect(isLatestRequest(1, 2)).toBe(false);
    expect(isLatestRequest(2, 2)).toBe(true);
  });
});

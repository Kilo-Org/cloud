import { describe, expect, it } from 'vitest';
import { DEADLINE_IDS, DEADLINE_MS } from '../deadlines.js';

describe('startup deadline', () => {
  it('is two minutes and stored under the startup name', () => {
    expect(DEADLINE_MS.startup).toBe(2 * 60_000);
    expect(DEADLINE_IDS).toContain('startup');
  });
});

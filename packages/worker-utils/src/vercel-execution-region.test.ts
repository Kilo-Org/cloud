import { describe, it, expect, afterEach } from 'vitest';
import { getVercelExecutionRegion } from './vercel-execution-region.js';

describe('getVercelExecutionRegion', () => {
  afterEach(() => {
    delete process.env.VERCEL_REGION;
  });

  it('returns the region when it is fra1', () => {
    process.env.VERCEL_REGION = 'fra1';
    expect(getVercelExecutionRegion()).toBe('fra1');
  });

  it('returns the region when it is sfo1', () => {
    process.env.VERCEL_REGION = 'sfo1';
    expect(getVercelExecutionRegion()).toBe('sfo1');
  });

  it('returns unknown for a region outside the whitelist', () => {
    process.env.VERCEL_REGION = 'iad1';
    expect(getVercelExecutionRegion()).toBe('unknown');
  });

  it('returns unknown when the region is unset', () => {
    expect(getVercelExecutionRegion()).toBe('unknown');
  });
});

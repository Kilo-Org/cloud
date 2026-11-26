import { describe, expect, it } from 'vitest';
import { STS_CANARY_DETAIL_MAX, StsCanaryCheckSchema, stsCanaryDetail } from './canary';

describe('STS canary check detail', () => {
  it('refuses a detail past the cap and truncates text to it', () => {
    const long = 'x'.repeat(STS_CANARY_DETAIL_MAX + 1);
    expect(
      StsCanaryCheckSchema.safeParse({ result: 'failed', status: null, detail: long }).success
    ).toBe(false);
    const detail = stsCanaryDetail(long);
    expect(detail).toHaveLength(STS_CANARY_DETAIL_MAX);
    expect(StsCanaryCheckSchema.safeParse({ result: 'failed', status: null, detail }).success).toBe(
      true
    );
    expect(stsCanaryDetail('expected 204')).toBe('expected 204');
  });
});

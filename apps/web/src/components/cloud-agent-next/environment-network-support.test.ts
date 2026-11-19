import { describe, expect, it } from '@jest/globals';
import { describeRestrictionSupport } from './environment-network-support';

describe('describeRestrictionSupport', () => {
  it('gives no guidance for full access', () => {
    expect(describeRestrictionSupport('full', null)).toBeNull();
    expect(describeRestrictionSupport('full', 'vercel-small')).toBeNull();
  });

  it('warns that the default sandbox may not support a restricted mode', () => {
    expect(describeRestrictionSupport('none', null)).toBe(
      'The default sandbox may not support restricted network access. If it does not, sessions will fail to start.'
    );
  });

  it('gives no guidance when the proxy sees all egress', () => {
    expect(describeRestrictionSupport('limited', 'cloudflare-containers-standard-3')).toBeNull();
    expect(describeRestrictionSupport('none', 'cloudflare-containers-standard-4')).toBeNull();
  });

  it('warns that a sandbox without the egress proxy fails to start', () => {
    expect(describeRestrictionSupport('limited', 'vercel-small')).toBe(
      'This sandbox cannot restrict network access, so sessions will fail to start.'
    );
  });
});

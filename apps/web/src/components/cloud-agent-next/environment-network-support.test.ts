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

  it('states the limits of a proxy that sees only the listed hosts', () => {
    const limits =
      'On this sandbox, plain http:// requests fail; use https://. A domain that is not allowed does not resolve, and the egress audit does not record it. The egress audit records requests only in None or Limited mode.';
    expect(describeRestrictionSupport('limited', 'vercel-small')).toBe(limits);
    expect(describeRestrictionSupport('none', 'vercel-large')).toBe(limits);
  });
});

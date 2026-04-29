import { describe, expect, it } from 'vitest';
import { rolloutBucket } from './rollout-bucket';

describe('rolloutBucket', () => {
  it('returns a value in [0, 99]', async () => {
    for (const key of ['a', 'b', 'instance:abc', 'tag:foo:instance:bar']) {
      const v = await rolloutBucket(key);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(99);
    }
  });

  it('is deterministic for the same key', async () => {
    const key = 'tag:kiloclaw-2026.4.15-abc:instance:550e8400-e29b-41d4-a716-446655440000';
    const a = await rolloutBucket(key);
    const b = await rolloutBucket(key);
    expect(a).toBe(b);
  });

  it('produces different buckets for different keys (high probability)', async () => {
    const a = await rolloutBucket('instance:1');
    const b = await rolloutBucket('instance:2');
    expect(a).not.toBe(b);
  });

  it('approximates a uniform distribution across many keys', async () => {
    const samples = 2000;
    const buckets = await Promise.all(
      Array.from({ length: samples }, (_, i) => rolloutBucket(`instance:${i}`))
    );
    const inFirstHalf = buckets.filter(v => v < 50).length;
    const ratio = inFirstHalf / samples;
    // Expect ~50% in [0, 50). Loose tolerance — uniform hash will land within a few pp.
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });

  it('changes the bucket for a fixed instanceId when the salt (imageTag) changes', async () => {
    const instanceId = '550e8400-e29b-41d4-a716-446655440001';
    const a = await rolloutBucket(`tag:kiloclaw-2026.4.15-aaa:instance:${instanceId}`);
    const b = await rolloutBucket(`tag:kiloclaw-2026.4.15-bbb:instance:${instanceId}`);
    // Two different salts (rebuilds of the same upstream version) must produce
    // independent draws so the same instance is not always the canary.
    expect(a).not.toBe(b);
  });
});

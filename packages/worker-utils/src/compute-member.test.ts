import { describe, expect, it } from 'vitest';
import { computeMemberId, computeMemberMetadata } from './compute-member';
import { CLOUD_AGENT_CONTAINER_SKUS } from './cloud-agent-compute';

describe('compute member attribution', () => {
  it('uses the user actor even when bot attribution is present', () => {
    expect(computeMemberId({ type: 'user', id: 'oauth/member' }, { billingUserId: 'other' })).toBe(
      'oauth/member'
    );
  });
  it('uses only trusted initiating-member metadata for a bot', () => {
    const actor = { type: 'bot', id: 'reviewer' } as const;
    expect(computeMemberId(actor, computeMemberMetadata(actor, 'oauth/member'))).toBe(
      'oauth/member'
    );
    expect(computeMemberId(actor)).toBeUndefined();
  });
  it('retains the exact supported instance keys', () => {
    expect(CLOUD_AGENT_CONTAINER_SKUS['standard-3']).toBe(
      'cloud-agent-containers-standard-3-2026-09'
    );
    // @ts-expect-error Unknown instance types must not compile.
    expect(CLOUD_AGENT_CONTAINER_SKUS['standard-5']).toBeUndefined();
  });
});

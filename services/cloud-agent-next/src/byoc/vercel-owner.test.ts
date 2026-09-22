import { describe, expect, it } from 'vitest';
import { enrolledByocVercelOwner, byocVercelOwnerSchema } from './vercel-owner.js';
import { controlPlaneSandboxSelectionSchema } from '../control-plane/session/sandbox-selection.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const userId = 'oauth/google/personal-owner';
const credentialId = '22222222-2222-4222-8222-222222222222';

describe('Vercel BYOC ownership', () => {
  it('uses the organization owner whenever an organization is present', () => {
    expect(enrolledByocVercelOwner({ BYOC_VERCEL_IDS: userId }, { userId, orgId })).toBeUndefined();
    expect(enrolledByocVercelOwner({ BYOC_VERCEL_IDS: orgId }, { userId })).toBeUndefined();
    expect(enrolledByocVercelOwner({ BYOC_VERCEL_IDS: orgId }, { userId, orgId })).toEqual({
      organizationId: orgId,
    });
  });
  it('enrolls both owner types with a wildcard and neither with an empty list', () => {
    expect(enrolledByocVercelOwner({ BYOC_VERCEL_IDS: '*' }, { userId })).toEqual({ userId });
    expect(enrolledByocVercelOwner({ BYOC_VERCEL_IDS: '*' }, { userId, orgId })).toEqual({
      organizationId: orgId,
    });
    expect(enrolledByocVercelOwner({}, { userId })).toBeUndefined();
    expect(enrolledByocVercelOwner({}, { userId, orgId })).toBeUndefined();
    expect(enrolledByocVercelOwner({ BYOC_VERCEL_IDS: '*' }, {})).toBeUndefined();
  });
  it('requires exactly one owner and Vercel at the provider pin boundary', () => {
    expect(controlPlaneSandboxSelectionSchema.safeParse({ provider: 'vercel' }).success).toBe(
      false
    );
    for (const owner of [{ userId }, { organizationId: orgId }]) {
      expect(
        controlPlaneSandboxSelectionSchema.safeParse({
          provider: 'vercel',
          byoc: { ...owner, credentialId },
        }).success
      ).toBe(true);
      expect(
        controlPlaneSandboxSelectionSchema.safeParse({
          provider: 'cloudflare',
          byoc: { ...owner, credentialId },
        }).success
      ).toBe(false);
    }
    for (const owner of [{}, { userId, organizationId: orgId }, { userId: '' }]) {
      expect(byocVercelOwnerSchema.safeParse(owner).success).toBe(false);
      expect(
        controlPlaneSandboxSelectionSchema.safeParse({
          provider: 'vercel',
          byoc: { ...owner, credentialId },
        }).success
      ).toBe(false);
    }
  });
});

import { TRPCError } from '@trpc/server';

const mockGetOrganizationById = jest.fn();
const mockGetMostRecentSeatPurchase = jest.fn();
const mockIsLocalCodeReviewDevelopmentEnabled = jest.fn();

jest.mock('@/lib/organizations/organizations', () => ({
  getOrganizationById: (...args: unknown[]) => mockGetOrganizationById(...args),
}));
jest.mock('@/lib/organizations/organization-seats', () => ({
  getMostRecentSeatPurchase: (...args: unknown[]) => mockGetMostRecentSeatPurchase(...args),
}));
jest.mock('@/lib/config.server', () => ({
  isLocalCodeReviewDevelopmentEnabled: () => mockIsLocalCodeReviewDevelopmentEnabled(),
}));

// Real classifyOrganizationEntitlement is used (not mocked) so the tests exercise the
// canonical active-entitlement logic layered on top of the plan tier.
import {
  isCouncilEntitledForOrganization,
  isCouncilEntitledForOwner,
  assertCouncilCreationAllowed,
} from './council-entitlement';

const DAY_MS = 24 * 60 * 60 * 1000;
const hardExpiredTrialEnd = new Date(Date.now() - 5 * DAY_MS).toISOString();

function enterpriseOrg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'org-1',
    plan: 'enterprise',
    created_at: new Date(Date.now() - 60 * DAY_MS).toISOString(),
    free_trial_end_at: hardExpiredTrialEnd,
    require_seats: true,
    settings: {},
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsLocalCodeReviewDevelopmentEnabled.mockReturnValue(false);
  mockGetMostRecentSeatPurchase.mockResolvedValue(null);
});

describe('isCouncilEntitledForOrganization', () => {
  it('returns true for an enterprise org with an active paid subscription', async () => {
    mockGetOrganizationById.mockResolvedValue(enterpriseOrg());
    mockGetMostRecentSeatPurchase.mockResolvedValue({ subscription_status: 'active' });

    await expect(isCouncilEntitledForOrganization('org-1')).resolves.toBe(true);
  });

  it('returns false for a lapsed enterprise org (plan still enterprise, subscription ended, trial hard-expired)', async () => {
    // Regression: plan is NOT downgraded on cancellation, so plan alone must not grant council.
    mockGetOrganizationById.mockResolvedValue(enterpriseOrg());
    mockGetMostRecentSeatPurchase.mockResolvedValue({ subscription_status: 'ended' });

    await expect(isCouncilEntitledForOrganization('org-1')).resolves.toBe(false);
  });

  it('returns false for a non-enterprise plan without checking subscription status', async () => {
    mockGetOrganizationById.mockResolvedValue(enterpriseOrg({ plan: 'teams' }));

    await expect(isCouncilEntitledForOrganization('org-1')).resolves.toBe(false);
    expect(mockGetMostRecentSeatPurchase).not.toHaveBeenCalled();
  });

  it('returns false when the organization does not exist or id is missing', async () => {
    mockGetOrganizationById.mockResolvedValue(null);
    await expect(isCouncilEntitledForOrganization('org-1')).resolves.toBe(false);
    await expect(isCouncilEntitledForOrganization(null)).resolves.toBe(false);
    expect(mockGetOrganizationById).toHaveBeenCalledTimes(1);
  });
});

describe('isCouncilEntitledForOwner', () => {
  it('is never entitled for personal (user) owners', async () => {
    await expect(isCouncilEntitledForOwner({ type: 'user', id: 'u1', userId: 'u1' })).resolves.toBe(
      false
    );
    expect(mockGetOrganizationById).not.toHaveBeenCalled();
  });
});

describe('assertCouncilCreationAllowed', () => {
  const orgOwner = { type: 'org', id: 'org-1', userId: 'u1' } as const;

  it('is a no-op for non-council reviews', async () => {
    await expect(
      assertCouncilCreationAllowed({ owner: orgOwner, reviewType: 'standard' })
    ).resolves.toBeUndefined();
    expect(mockGetOrganizationById).not.toHaveBeenCalled();
  });

  it('throws FORBIDDEN when a council review is requested without entitlement', async () => {
    mockGetOrganizationById.mockResolvedValue(enterpriseOrg());
    mockGetMostRecentSeatPurchase.mockResolvedValue({ subscription_status: 'ended' });

    await expect(
      assertCouncilCreationAllowed({ owner: orgOwner, reviewType: 'council' })
    ).rejects.toThrow(TRPCError);
  });

  it('allows a council review for an entitled enterprise org', async () => {
    mockGetOrganizationById.mockResolvedValue(enterpriseOrg());
    mockGetMostRecentSeatPurchase.mockResolvedValue({ subscription_status: 'active' });

    await expect(
      assertCouncilCreationAllowed({ owner: orgOwner, reviewType: 'council' })
    ).resolves.toBeUndefined();
  });

  it('bypasses entitlement in local development', async () => {
    mockIsLocalCodeReviewDevelopmentEnabled.mockReturnValue(true);

    await expect(
      assertCouncilCreationAllowed({ owner: orgOwner, reviewType: 'council' })
    ).resolves.toBeUndefined();
    expect(mockGetOrganizationById).not.toHaveBeenCalled();
  });
});

import { and, eq, inArray } from 'drizzle-orm';
import {
  buildOrganizationRecommendationsDigest,
  currentDigestPeriodKey,
  dispatchEnterpriseRecommendationsDigests,
  getOrganizationOwnerRecipients,
} from './recommendations-digest';
import { db } from '@/lib/drizzle';
import {
  kilocode_users,
  organization_memberships,
  organizations,
  transactional_email_log,
} from '@kilocode/db/schema';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';

jest.mock('./recommendations', () => ({
  getOrganizationRecommendations: jest.fn(),
}));

jest.mock('@/lib/email', () => ({
  sendRecommendationsDigestEmail: jest.fn(),
}));

import { sendRecommendationsDigestEmail } from '@/lib/email';
import { getOrganizationRecommendations } from './recommendations';

const mockedGetRecommendations = jest.mocked(getOrganizationRecommendations);
const mockedSendRecommendationsDigestEmail = jest.mocked(sendRecommendationsDigestEmail);

type ResolvedRecommendations = Awaited<ReturnType<typeof getOrganizationRecommendations>>;

function check(adopted: boolean) {
  return {
    key: 'source-control-integration',
    title: 'Source control',
    description: 'desc',
    adopted,
    adoptedLabel: 'Connected',
    notAdoptedLabel: 'Not connected',
    actionLabel: 'Connect',
    actionUrl: '/x',
  };
}

function recommendation(status: 'open' | 'completed' | 'dismissed', index: number) {
  return {
    key: `rec-${index}`,
    feature: 'code-reviewer',
    status,
    title: `Title ${index}`,
    description: `Description ${index}`,
    actionLabel: `Action ${index}`,
    actionUrl: `/organizations/org/setting-${index}`,
    severity: 'suggestion',
  };
}

function mockResolved(
  plan: 'teams' | 'enterprise',
  checks: ReturnType<typeof check>[],
  recommendations: ReturnType<typeof recommendation>[]
) {
  mockedGetRecommendations.mockResolvedValue({
    plan,
    checks,
    recommendations,
  } as unknown as ResolvedRecommendations);
}

describe('buildOrganizationRecommendationsDigest', () => {
  beforeEach(() => {
    mockedGetRecommendations.mockReset();
  });

  it('returns null for non-enterprise organizations', async () => {
    mockResolved('teams', [], []);

    const result = await buildOrganizationRecommendationsDigest('org-1', 'Acme');

    expect(result).toBeNull();
  });

  it('returns null when there are no open recommendations (skip-empty)', async () => {
    mockResolved(
      'enterprise',
      [check(true), check(true)],
      [recommendation('completed', 0), recommendation('dismissed', 1)]
    );

    const result = await buildOrganizationRecommendationsDigest('org-1', 'Acme');

    expect(result).toBeNull();
  });

  it('builds the payload with adoption counts and only open recommendations', async () => {
    mockResolved(
      'enterprise',
      [check(true), check(true), check(true), check(false), check(false), check(false)],
      [recommendation('open', 0), recommendation('completed', 1), recommendation('open', 2)]
    );

    const result = await buildOrganizationRecommendationsDigest('org-1', 'Acme');

    expect(result).not.toBeNull();
    expect(result?.organizationName).toBe('Acme');
    expect(result?.adoptedCount).toBe(3);
    expect(result?.totalCount).toBe(6);
    expect(result?.openCount).toBe(2);
    expect(result?.recommendations.map(r => r.title)).toEqual(['Title 0', 'Title 2']);
  });

  it('caps the listed recommendations at three but keeps the full open count', async () => {
    const openRecs = Array.from({ length: 5 }, (_, i) => recommendation('open', i));
    mockResolved('enterprise', [check(true)], openRecs);

    const result = await buildOrganizationRecommendationsDigest('org-1', 'Acme');

    expect(result?.openCount).toBe(5);
    expect(result?.recommendations).toHaveLength(3);
    expect(result?.recommendations.map(r => r.title)).toEqual(['Title 0', 'Title 1', 'Title 2']);
  });
});

describe('currentDigestPeriodKey', () => {
  it("returns the week's Monday (UTC) for any day in that week", () => {
    // 2026-06-22 is a Monday; every day Mon..Sun maps to it.
    expect(currentDigestPeriodKey(new Date('2026-06-22T09:00:00Z'))).toBe('2026-06-22');
    expect(currentDigestPeriodKey(new Date('2026-06-24T23:30:00Z'))).toBe('2026-06-22');
    expect(currentDigestPeriodKey(new Date('2026-06-28T00:00:00Z'))).toBe('2026-06-22');
  });

  it('rolls over to the next Monday for the following week', () => {
    expect(currentDigestPeriodKey(new Date('2026-06-29T00:00:00Z'))).toBe('2026-06-29');
  });
});

describe('recommendations digest dispatch', () => {
  const userIds: string[] = [];
  const organizationIds: string[] = [];

  beforeEach(() => {
    mockedGetRecommendations.mockReset();
    mockedSendRecommendationsDigestEmail.mockReset();
  });

  afterEach(async () => {
    if (organizationIds.length > 0) {
      await db.delete(organizations).where(inArray(organizations.id, organizationIds.splice(0)));
    }
    if (userIds.length > 0) {
      await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds.splice(0)));
    }
  });

  async function createEnabledOrganizationWithTwoOwners() {
    const firstOwner = await insertTestUser();
    const secondOwner = await insertTestUser();
    userIds.push(firstOwner.id, secondOwner.id);

    const organization = await createTestOrganization('Digest dispatch org', firstOwner.id, 0, {
      recommendations_digest_enabled: true,
    });
    organizationIds.push(organization.id);

    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: secondOwner.id,
      role: 'owner',
    });

    return { organization, firstOwner, secondOwner };
  }

  it('returns owner user IDs with email addresses for non-PII idempotency', async () => {
    const { organization, firstOwner, secondOwner } =
      await createEnabledOrganizationWithTwoOwners();

    const recipients = await getOrganizationOwnerRecipients(organization.id);

    expect(recipients).toEqual(
      expect.arrayContaining([
        { userId: firstOwner.id, email: firstOwner.google_user_email },
        { userId: secondOwner.id, email: secondOwner.google_user_email },
      ])
    );
  });

  it('releases a failed claim and continues sending to remaining owners', async () => {
    const { organization, firstOwner, secondOwner } =
      await createEnabledOrganizationWithTwoOwners();
    mockResolved('enterprise', [check(false)], [recommendation('open', 0)]);
    mockedSendRecommendationsDigestEmail
      .mockRejectedValueOnce(new Error('Mailgun unavailable'))
      .mockResolvedValueOnce({ sent: true });

    const summary = await dispatchEnterpriseRecommendationsDigests();

    expect(summary.emailFailures).toBe(1);
    expect(summary.emailsSent).toBe(1);
    expect(mockedSendRecommendationsDigestEmail).toHaveBeenCalledTimes(2);

    const markers = await db
      .select({ idempotencyKey: transactional_email_log.idempotency_key })
      .from(transactional_email_log)
      .where(
        and(
          eq(transactional_email_log.organization_id, organization.id),
          eq(transactional_email_log.email_type, 'recommendations_digest')
        )
      );
    expect(markers).toHaveLength(1);
    expect(markers[0].idempotencyKey).not.toContain(firstOwner.google_user_email);
    expect(markers[0].idempotencyKey).not.toContain(secondOwner.google_user_email);
  });
});

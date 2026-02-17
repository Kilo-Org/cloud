import { describe, test, expect, afterEach } from '@jest/globals';
import { GET, OPTIONS } from './route';
import { db } from '@/lib/drizzle';
import { organizations, organization_memberships, kilocode_users } from '@/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import type { OrganizationSettings } from '@/lib/organizations/organization-base-types';

describe('GET /api/public/oss-sponsors', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_memberships);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilocode_users);
  });

  test('returns empty array when no OSS sponsors exist', async () => {
    const response = await GET();
    const body = await response.json();
    expect(body).toEqual([]);
  });

  test('returns only sponsors with both oss_sponsorship_tier and oss_github_url', async () => {
    const user = await insertTestUser();

    // Org with both tier and github url — should be included
    const ossSettings: OrganizationSettings = {
      oss_sponsorship_tier: 1,
      oss_github_url: 'https://github.com/test-org/repo-a',
    };
    await createTestOrganization('repo-a', user.id, 0, ossSettings);

    // Org with tier but no github url — should be excluded
    const tierOnlySettings: OrganizationSettings = {
      oss_sponsorship_tier: 2,
    };
    await createTestOrganization('repo-b', user.id, 0, tierOnlySettings);

    // Org with no OSS settings — should be excluded
    await createTestOrganization('regular-org', user.id, 0);

    const response = await GET();
    const body = await response.json();

    expect(body).toEqual([
      { githubUrl: 'https://github.com/test-org/repo-a', tier: 1 },
    ]);
  });

  test('returns multiple sponsors sorted by database order', async () => {
    const user = await insertTestUser();

    await createTestOrganization('repo-x', user.id, 0, {
      oss_sponsorship_tier: 1,
      oss_github_url: 'https://github.com/org1/repo-x',
    } satisfies OrganizationSettings);

    await createTestOrganization('repo-y', user.id, 0, {
      oss_sponsorship_tier: 3,
      oss_github_url: 'https://github.com/org2/repo-y',
    } satisfies OrganizationSettings);

    const response = await GET();
    const body = await response.json();

    expect(body).toHaveLength(2);
    expect(body).toEqual(
      expect.arrayContaining([
        { githubUrl: 'https://github.com/org1/repo-x', tier: 1 },
        { githubUrl: 'https://github.com/org2/repo-y', tier: 3 },
      ])
    );
  });

  test('does not leak any org metadata', async () => {
    const user = await insertTestUser();

    await createTestOrganization('repo-secret', user.id, 5_000_000, {
      oss_sponsorship_tier: 2,
      oss_github_url: 'https://github.com/secret-org/repo-secret',
      oss_monthly_credit_amount_microdollars: 10_000_000,
    } satisfies OrganizationSettings);

    const response = await GET();
    const body = await response.json();

    expect(body).toHaveLength(1);
    const sponsor = body[0];
    // Only these two keys should exist
    expect(Object.keys(sponsor).sort()).toEqual(['githubUrl', 'tier']);
  });

  test('sets Cache-Control and CORS headers', async () => {
    const response = await GET();

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET');
  });

  test('excludes soft-deleted organizations', async () => {
    const user = await insertTestUser();

    const org = await createTestOrganization('deleted-repo', user.id, 0, {
      oss_sponsorship_tier: 1,
      oss_github_url: 'https://github.com/deleted/repo',
    } satisfies OrganizationSettings);

    // Soft-delete the org
    const { eq } = await import('drizzle-orm');
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, org.id));

    const response = await GET();
    const body = await response.json();
    expect(body).toEqual([]);
  });
});

describe('OPTIONS /api/public/oss-sponsors', () => {
  test('returns 204 with CORS headers', async () => {
    const response = await OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET');
  });
});

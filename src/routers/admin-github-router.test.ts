import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import {
  getKilocodeRepoOpenPullRequestCounts,
  getKilocodeRepoOpenPullRequestsSummary,
  getKilocodeRepoRecentlyClosedExternalPRs,
  getKilocodeRepoRecentlyMergedExternalPRs,
} from '@/lib/github/open-pull-request-counts';

jest.mock('@/lib/github/open-pull-request-counts', () => ({
  getKilocodeRepoOpenPullRequestCounts: jest.fn(),
  getKilocodeRepoOpenPullRequestsSummary: jest.fn(),
  getKilocodeRepoRecentlyClosedExternalPRs: jest.fn(),
  getKilocodeRepoRecentlyMergedExternalPRs: jest.fn(),
}));

let regularUser: User;
let adminUser: User;

describe('admin.github.getKilocodeOpenPullRequestCounts', () => {
  beforeAll(async () => {
    regularUser = await insertTestUser({
      google_user_email: 'regular-github-prs@example.com',
      google_user_name: 'Regular User',
      is_admin: false,
    });

    adminUser = await insertTestUser({
      google_user_email: 'admin-github-prs@admin.example.com',
      google_user_name: 'Admin User',
      is_admin: true,
    });
  });

  it('throws FORBIDDEN for non-admin users', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.admin.github.getKilocodeOpenPullRequestCounts()).rejects.toThrow(
      'Admin access required'
    );
  });

  it('returns PR counts for admin users', async () => {
    const mockCounts = {
      totalOpenPullRequests: 10,
      teamOpenPullRequests: 4,
      externalOpenPullRequests: 6,
      updatedAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
    };

    (getKilocodeRepoOpenPullRequestCounts as jest.Mock).mockResolvedValue(mockCounts);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.github.getKilocodeOpenPullRequestCounts();

    expect(result).toEqual(mockCounts);
  });
});

describe('admin.github.getKilocodeOpenPullRequestsSummary', () => {
  it('throws FORBIDDEN for non-admin users', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.admin.github.getKilocodeOpenPullRequestsSummary()).rejects.toThrow(
      'Admin access required'
    );
  });

  it('returns summary for admin users', async () => {
    const mockSummary = {
      totalOpenPullRequests: 10,
      teamOpenPullRequests: 4,
      externalOpenPullRequests: 6,
      externalOpenPullRequestsList: [
        {
          number: 123,
          title: 'Fix thing',
          url: 'https://github.com/Kilo-Org/kilocode/pull/123',
          authorLogin: 'external-user',
          createdAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
          ageDays: 12,
          commentCount: 3,
          teamCommented: true,
          reviewStatus: 'commented',
        },
      ],
      updatedAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
    };

    (getKilocodeRepoOpenPullRequestsSummary as jest.Mock).mockResolvedValue(mockSummary);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.github.getKilocodeOpenPullRequestsSummary();

    expect(result).toEqual(mockSummary);
  });

  it('always returns numeric commentCount values for external PR rows', async () => {
    const mockSummary = {
      totalOpenPullRequests: 1,
      teamOpenPullRequests: 0,
      externalOpenPullRequests: 1,
      externalOpenPullRequestsList: [
        {
          number: 1,
          title: 'Example',
          url: 'https://github.com/Kilo-Org/kilocode/pull/1',
          authorLogin: 'external-user',
          createdAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
          ageDays: 1,
          commentCount: 0,
          teamCommented: false,
          reviewStatus: 'no_reviews',
        },
      ],
      updatedAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
    };

    (getKilocodeRepoOpenPullRequestsSummary as jest.Mock).mockResolvedValue(mockSummary);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.github.getKilocodeOpenPullRequestsSummary();

    expect(
      result.externalOpenPullRequestsList.every(pr => typeof pr.commentCount === 'number')
    ).toBe(true);
  });
});

describe('admin.github.getKilocodeRecentlyMergedExternalPRs', () => {
  it('throws FORBIDDEN for non-admin users', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.admin.github.getKilocodeRecentlyMergedExternalPRs()).rejects.toThrow(
      'Admin access required'
    );
  });

  it('returns recently merged external PRs for admin users', async () => {
    const mockMergedPrs = [
      {
        number: 456,
        title: 'External feature',
        url: 'https://github.com/Kilo-Org/kilocode/pull/456',
        authorLogin: 'external-contributor',
        mergedAt: new Date('2024-01-15T10:00:00.000Z').toISOString(),
      },
      {
        number: 789,
        title: 'Another fix',
        url: 'https://github.com/Kilo-Org/kilocode/pull/789',
        authorLogin: 'community-dev',
        mergedAt: new Date('2024-01-14T08:00:00.000Z').toISOString(),
      },
    ];

    (getKilocodeRepoRecentlyMergedExternalPRs as jest.Mock).mockResolvedValue(mockMergedPrs);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.github.getKilocodeRecentlyMergedExternalPRs();

    expect(result).toEqual(mockMergedPrs);
    expect(result.length).toBe(2);
    expect(result[0]?.number).toBe(456);
  });

  it('returns empty array when no merged PRs', async () => {
    (getKilocodeRepoRecentlyMergedExternalPRs as jest.Mock).mockResolvedValue([]);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.github.getKilocodeRecentlyMergedExternalPRs();

    expect(result).toEqual([]);
  });
});

describe('admin.github.getKilocodeRecentlyClosedExternalPRs', () => {
  it('throws FORBIDDEN for non-admin users', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.admin.github.getKilocodeRecentlyClosedExternalPRs()).rejects.toThrow(
      'Admin access required'
    );
  });

  it('returns recently closed external PRs for admin users', async () => {
    const mockClosedPrs = {
      prs: [
        {
          number: 456,
          title: 'External feature',
          url: 'https://github.com/Kilo-Org/kilocode/pull/456',
          authorLogin: 'external-contributor',
          closedAt: new Date('2024-01-15T10:00:00.000Z').toISOString(),
          mergedAt: new Date('2024-01-15T09:00:00.000Z').toISOString(),
          status: 'merged',
          displayDate: new Date('2024-01-15T09:00:00.000Z').toISOString(),
        },
        {
          number: 789,
          title: 'Declined change',
          url: 'https://github.com/Kilo-Org/kilocode/pull/789',
          authorLogin: 'community-dev',
          closedAt: new Date('2024-01-14T08:00:00.000Z').toISOString(),
          mergedAt: null,
          status: 'closed',
          displayDate: new Date('2024-01-14T08:00:00.000Z').toISOString(),
        },
      ],
      thisWeekMergedCount: 1,
      thisWeekClosedCount: 0,
      weekStart: new Date('2024-01-15T00:00:00.000Z').toISOString(),
      weekEnd: new Date('2024-01-22T00:00:00.000Z').toISOString(),
    };

    (getKilocodeRepoRecentlyClosedExternalPRs as jest.Mock).mockResolvedValue(mockClosedPrs);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.github.getKilocodeRecentlyClosedExternalPRs();

    expect(result).toEqual(mockClosedPrs);
    expect(result.prs.length).toBe(2);
    expect(result.prs[0]?.status).toBe('merged');
    expect(result.prs[1]?.status).toBe('closed');
    expect(typeof result.thisWeekMergedCount).toBe('number');
    expect(typeof result.thisWeekClosedCount).toBe('number');
    expect(typeof result.weekStart).toBe('string');
  });

  it('returns empty array when no closed PRs', async () => {
    (getKilocodeRepoRecentlyClosedExternalPRs as jest.Mock).mockResolvedValue({
      prs: [],
      thisWeekMergedCount: 0,
      thisWeekClosedCount: 0,
      weekStart: new Date('2024-01-15T00:00:00.000Z').toISOString(),
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.github.getKilocodeRecentlyClosedExternalPRs();

    expect(result.prs).toEqual([]);
    expect(result.thisWeekMergedCount).toBe(0);
    expect(result.thisWeekClosedCount).toBe(0);
    expect(typeof result.weekStart).toBe('string');
  });
});

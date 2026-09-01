import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import {
  getKilocodeRepoOpenPullRequestsSummary,
  getKilocodeRepoRecentlyClosedExternalPRs,
} from '@/lib/github/open-pull-request-counts';

jest.mock('@/lib/github/open-pull-request-counts', () => ({
  getKilocodeRepoOpenPullRequestCounts: jest.fn(),
  getKilocodeRepoOpenPullRequestsSummary: jest.fn(),
  getKilocodeRepoRecentlyClosedExternalPRs: jest.fn(),
  getKilocodeRepoRecentlyMergedExternalPRs: jest.fn(),
  ALL_REPO_IDS: ['kilocode', 'cloud', 'kilo-marketplace', 'kilocode-legacy'],
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
});

describe('admin.github.getKilocodeOpenPullRequestsSummary', () => {
  it('throws FORBIDDEN for non-admin users', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.admin.github.getKilocodeOpenPullRequestsSummary()).rejects.toThrow(
      'Admin access required'
    );
  });

  it('returns the service response and passes repos/includeDrafts through to the service', async () => {
    const mockSummary = {
      totalOpenPullRequests: 1,
      teamOpenPullRequests: 0,
      externalOpenPullRequests: 1,
      externalOpenPullRequestsList: [],
      updatedAt: new Date().toISOString(),
    };

    (getKilocodeRepoOpenPullRequestsSummary as jest.Mock).mockResolvedValue(mockSummary);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.github.getKilocodeOpenPullRequestsSummary({
      repos: ['kilocode', 'cloud'],
      includeDrafts: true,
    });

    expect(result).toEqual(mockSummary);
    expect(getKilocodeRepoOpenPullRequestsSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ['kilocode', 'cloud'],
        includeDrafts: true,
      })
    );
  });
});

describe('admin.github.getKilocodeRecentlyMergedExternalPRs', () => {
  it('throws FORBIDDEN for non-admin users', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.admin.github.getKilocodeRecentlyMergedExternalPRs()).rejects.toThrow(
      'Admin access required'
    );
  });
});

describe('admin.github.getKilocodeRecentlyClosedExternalPRs', () => {
  it('throws FORBIDDEN for non-admin users', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.admin.github.getKilocodeRecentlyClosedExternalPRs()).rejects.toThrow(
      'Admin access required'
    );
  });

  it('returns the service response and passes repos parameter through to the service', async () => {
    const mockClosedPrs = {
      prs: [
        {
          number: 456,
          title: 'External feature',
          url: 'https://github.com/Kilo-Org/kilocode/pull/456',
          repo: 'kilocode',
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
          repo: 'kilocode',
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
    const result = await caller.admin.github.getKilocodeRecentlyClosedExternalPRs({
      repos: ['cloud'],
    });

    expect(result).toEqual(mockClosedPrs);
    expect(getKilocodeRepoRecentlyClosedExternalPRs).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ['cloud'],
      })
    );
  });
});

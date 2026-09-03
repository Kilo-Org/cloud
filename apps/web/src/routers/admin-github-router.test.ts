import { createCallerForUser } from '@/routers/test-utils';
import { createCallerFactory } from '@/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import {
  getKilocodeRepoOpenPullRequestsSummary,
  getKilocodeRepoRecentlyClosedExternalPRs,
} from '@/lib/github/open-pull-request-counts';
import { lookupGitHubOrganizationInstallation } from '@/lib/admin/github-installation-lookup';
import { setAdminAccessSinkForTest } from '@/lib/admin/admin-access-log';

jest.mock('@/lib/github/open-pull-request-counts', () => ({
  getKilocodeRepoOpenPullRequestCounts: jest.fn(),
  getKilocodeRepoOpenPullRequestsSummary: jest.fn(),
  getKilocodeRepoRecentlyClosedExternalPRs: jest.fn(),
  getKilocodeRepoRecentlyMergedExternalPRs: jest.fn(),
  ALL_REPO_IDS: ['kilocode', 'cloud', 'kilo-marketplace', 'kilocode-legacy'],
}));

jest.mock('@/lib/admin/github-installation-lookup', () => ({
  lookupGitHubOrganizationInstallation: jest.fn(),
}));

let regularUser: User;
let adminUser: User;

beforeEach(() => {
  jest.clearAllMocks();
});

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

describe('admin.github.lookupOrganizationInstallation', () => {
  it('denies anonymous callers before a lookup', async () => {
    const createCaller = createCallerFactory(rootRouter);
    const caller = createCaller({ user: null } as never);

    await expect(
      caller.admin.github.lookupOrganizationInstallation({ organization: 'acme' })
    ).rejects.toThrow();
    expect(lookupGitHubOrganizationInstallation).not.toHaveBeenCalled();
  });

  it('denies non-admin callers before a lookup', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(
      caller.admin.github.lookupOrganizationInstallation({ organization: 'acme' })
    ).rejects.toThrow('Admin access required');
    expect(lookupGitHubOrganizationInstallation).not.toHaveBeenCalled();
  });

  it('normalizes input and delegates only for an admin', async () => {
    const response = {
      organization: 'acme',
      checkedAt: new Date().toISOString(),
      apps: [],
      records: [],
      recordsTruncated: false,
    };
    (lookupGitHubOrganizationInstallation as jest.Mock).mockResolvedValue(response);

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.github.lookupOrganizationInstallation({
        organization: 'https://github.com/acme/',
      })
    ).resolves.toEqual(response);
    expect(lookupGitHubOrganizationInstallation).toHaveBeenCalledWith('acme');
  });

  it('returns a generic error when the database lookup fails', async () => {
    const sentinel = 'SELECT secret FROM platform_integrations WHERE account = acme';
    (lookupGitHubOrganizationInstallation as jest.Mock).mockRejectedValue(new Error(sentinel));
    const caller = await createCallerForUser(adminUser.id);

    const error = await caller.admin.github
      .lookupOrganizationInstallation({ organization: 'acme' })
      .catch(error => error);

    expect(error).toHaveProperty('message', 'GitHub installation lookup failed');
    expect(error.message).not.toContain(sentinel);
    expect(error.cause).toBeUndefined();
  });

  it('preserves admin guard auditing without lookup input or results', async () => {
    const sink = jest.fn();
    setAdminAccessSinkForTest(sink);
    (lookupGitHubOrganizationInstallation as jest.Mock).mockResolvedValue({
      organization: 'private-lookup-target',
      records: [{ id: 'private-lookup-result' }],
    });

    try {
      const caller = await createCallerForUser(adminUser.id);
      await caller.admin.github.lookupOrganizationInstallation({
        organization: 'private-lookup-target',
      });
      expect(sink).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'admin_guard',
          route: 'admin.github.lookupOrganizationInstallation',
          method: 'mutation',
          target: null,
        })
      );
      expect(JSON.stringify(sink.mock.calls)).not.toContain('private-lookup-target');
      expect(JSON.stringify(sink.mock.calls)).not.toContain('private-lookup-result');
    } finally {
      setAdminAccessSinkForTest(null);
    }
  });

  it('rejects invalid input without calling the lookup', async () => {
    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.github.lookupOrganizationInstallation({ organization: 'acme--tools' })
    ).rejects.toThrow('Enter a valid GitHub organization login');
    expect(lookupGitHubOrganizationInstallation).not.toHaveBeenCalled();
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

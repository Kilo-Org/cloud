// The unit suite mocks drizzle, so it cannot pin the installed-repository SQL.
// This suite runs the real slice selection against the database: the bound, the
// rotation across runs, the health filter, and the unaddressable count.
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchOpenPullRequests: async () => [] as OpenPullRequest[],
}));

jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  // The authorization must not reach GitHub; the slice is what this suite proves.
  assertGitHubInstallationRuntimeAuthorized: async () => undefined,
  GitHubRuntimeAuthorizationError: class extends Error {
    constructor() {
      super('runtime authorization unavailable');
      this.name = 'GitHubRuntimeAuthorizationError';
    }
  },
}));

import { eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  kilocode_users,
  platform_integrations,
  type PlatformIntegration,
} from '@kilocode/db/schema';
import type { OpenPullRequest } from '@/lib/integrations/platforms/github/adapter';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  recoverMissedReviews,
  recoverMissedReviewsSliceOffset,
  RECOVER_MISSED_REVIEWS_REPO_LIMIT,
} from './recover-missed-reviews';

const OUTSIDE_PLATFORM_NAME = `outside-${Date.now()}`;

function repositories(indexes: number[]): PlatformIntegration['repositories'] {
  return indexes.map(index => ({
    id: 7000 + index,
    name: `repo-${index}`,
    full_name: `slice-owner/repo-${index}`,
    clone_url: `https://github.com/slice-owner/repo-${index}.git`,
    private: true,
  }));
}

describe('recoverMissedReviews slice selection against the database', () => {
  let userId: string;
  const integrationIds: string[] = [];

  beforeAll(async () => {
    const user = await insertTestUser();
    userId = user.id;
  });

  afterEach(async () => {
    for (const id of integrationIds.splice(0)) {
      await db.delete(platform_integrations).where(eq(platform_integrations.id, id));
    }
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  });

  async function insertIntegration(overrides: Record<string, unknown> = {}): Promise<string> {
    const [row] = await db
      .insert(platform_integrations)
      .values({
        platform: 'github',
        integration_type: 'app',
        integration_status: 'active',
        platform_installation_id: String(90_000 + integrationIds.length),
        github_app_type: 'standard',
        owned_by_user_id: userId,
        kilo_requester_user_id: userId,
        repositories: [],
        ...overrides,
      })
      .returning({ id: platform_integrations.id });
    integrationIds.push(row.id);
    return row.id;
  }

  it('sweeps at most the bound and steps across the fleet in later runs', async () => {
    const installed = RECOVER_MISSED_REVIEWS_REPO_LIMIT + 7;
    await insertIntegration({
      repositories: repositories(Array.from({ length: installed }, (_, i) => i)),
    });

    const first = await recoverMissedReviews({ now: new Date('2026-11-09T12:00:00Z') });
    expect(first.repositoriesConsidered).toBe(RECOVER_MISSED_REVIEWS_REPO_LIMIT);
    expect(first.unaddressableRepositories).toBe(0);

    const second = await recoverMissedReviews({ now: new Date('2026-11-09T12:15:00Z') });
    expect(second.repositoriesConsidered).toBe(7);

    // A later rotation step wraps back to the first slice.
    const offset = recoverMissedReviewsSliceOffset(installed, new Date('2026-11-09T12:30:00Z'));
    expect(offset).toBe(0);
  });

  it('counts a repository entry the payload cannot address', async () => {
    await insertIntegration({
      repositories: [
        { id: 8001, name: 'good', full_name: 'slice-owner/good', private: true },
        // A string platform id cannot name a review payload repository.
        { id: '8002', name: 'bad', full_name: 'slice-owner/bad', private: true },
      ],
    });

    const summary = await recoverMissedReviews({ now: new Date('2026-11-09T12:00:00Z') });
    expect(summary.unaddressableRepositories).toBe(1);
    expect(summary.repositoriesConsidered).toBe(1);
  });

  it('ignores an entry whose name does not split on one slash', async () => {
    await insertIntegration({
      repositories: [
        { id: 8101, name: 'good', full_name: 'slice-owner/good', private: true },
        { id: 8102, name: 'flat', full_name: 'slice-owner-from-something', private: true },
      ],
    });

    const summary = await recoverMissedReviews({ now: new Date('2026-11-09T12:00:00Z') });
    expect(summary.repositoriesConsidered).toBe(1);
  });

  it('skips an unhealthy integration everywhere in the fleet', async () => {
    await insertIntegration({ repositories: repositories([0, 1]) });
    await insertIntegration({
      integration_status: 'suspended',
      suspended_at: new Date().toISOString(),
      repositories: repositories([2, 3]),
    });

    const summary = await recoverMissedReviews({ now: new Date('2026-11-09T12:00:00Z') });
    // Both healthy-fleet repositories fit one slice. The suspended integration
    // is invisible to the count as well as to the slice.
    expect(summary.repositoriesConsidered).toBe(2);
  });

  it('sweeps nothing when the platform is outside the sweep', async () => {
    await insertIntegration({ platform: OUTSIDE_PLATFORM_NAME, repositories: repositories([0]) });

    const summary = await recoverMissedReviews({ now: new Date('2026-11-09T12:00:00Z') });
    expect(summary.repositoriesConsidered).toBe(0);
  });
});

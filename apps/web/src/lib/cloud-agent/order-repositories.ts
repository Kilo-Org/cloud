import 'server-only';

import { and, count, eq, isNotNull, isNull, max } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { normalizeGitUrl } from '@kilocode/worker-utils/normalize-git-url';
import { buildGitLabCloneUrl } from '@/lib/cloud-agent/gitlab-integration-helpers';

const DEFAULT_GITLAB_URL = 'https://gitlab.com';

type RepositoryPlatform = 'github' | 'gitlab' | 'bitbucket';

type RepositoryWithFullName = { fullName: string };

type UsageRecord = {
  count: number;
  latestUsedAt: string;
};

function buildRepositoryUrl(
  fullName: string,
  platform: RepositoryPlatform,
  gitlabInstanceUrl?: string
): string {
  switch (platform) {
    case 'github':
      return `https://github.com/${fullName}`;
    case 'bitbucket':
      return `https://bitbucket.org/${fullName}.git`;
    case 'gitlab':
      return buildGitLabCloneUrl(fullName, gitlabInstanceUrl ?? DEFAULT_GITLAB_URL);
  }
}

/**
 * Order provider repositories by the caller's Cloud Agent usage history.
 *
 * Used repositories sort by session count descending, latest use descending,
 * then normalized key ascending. Unused repositories keep their original
 * provider order. A rank-read failure returns the original array unchanged;
 * provider fetch errors are never swallowed here.
 */
export async function orderRepositoriesByUsage<T extends RepositoryWithFullName>(params: {
  userId: string;
  organizationId: string | null;
  platform: RepositoryPlatform;
  repositories: T[];
  gitlabInstanceUrl?: string;
}): Promise<T[]> {
  const { userId, organizationId, platform, repositories, gitlabInstanceUrl } = params;

  const keyed = repositories.map(repo => ({
    repo,
    key: normalizeGitUrl(buildRepositoryUrl(repo.fullName, platform, gitlabInstanceUrl)),
  }));

  let usageByKey: Map<string, UsageRecord>;
  try {
    const rows = await db
      .select({
        gitUrl: cli_sessions_v2.git_url,
        count: count(),
        latestUsedAt: max(cli_sessions_v2.created_at),
      })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, userId),
          organizationId === null
            ? isNull(cli_sessions_v2.organization_id)
            : eq(cli_sessions_v2.organization_id, organizationId),
          isNull(cli_sessions_v2.parent_session_id),
          isNotNull(cli_sessions_v2.cloud_agent_session_id),
          isNotNull(cli_sessions_v2.git_url)
        )
      )
      .groupBy(cli_sessions_v2.git_url);

    usageByKey = new Map();
    for (const row of rows) {
      if (!row.gitUrl) continue;
      const key = normalizeGitUrl(row.gitUrl);
      const count = Number(row.count);
      const latestUsedAt = row.latestUsedAt ?? '';
      const existing = usageByKey.get(key);
      if (existing) {
        existing.count += count;
        if (latestUsedAt > existing.latestUsedAt) {
          existing.latestUsedAt = latestUsedAt;
        }
      } else {
        usageByKey.set(key, { count, latestUsedAt });
      }
    }
  } catch {
    // Rank-read failure only: keep the legacy provider order and fields.
    return repositories;
  }

  const used: { repo: T; key: string; count: number; latestUsedAt: string }[] = [];
  const unused: T[] = [];

  for (const { repo, key } of keyed) {
    const usage = usageByKey.get(key);
    if (usage) {
      used.push({ repo, key, count: usage.count, latestUsedAt: usage.latestUsedAt });
    } else {
      unused.push(repo);
    }
  }

  used.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.latestUsedAt !== b.latestUsedAt) {
      return a.latestUsedAt > b.latestUsedAt ? -1 : 1;
    }
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });

  return [...used.map(entry => entry.repo), ...unused];
}

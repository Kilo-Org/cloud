import { eq } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { githubCache } from './db/schema';
import type { GithubClient, PullSummary, Review, TreeEntry } from './github';

/**
 * The GitHub reads of the fetch and the owner-approval check, cached in the object's SQLite
 * (contract §5 step 5, "Cache and rate limits"). Trees, the newest commit touching a path at a
 * commit, and the blob at a review's commit never change. A commit's merged PR is cached only once
 * exactly one is known (right after a merge GitHub may not list it yet). A PR's reviews change, so
 * their entry is reused only when it was fetched after `freshAfter`, the run's creation, so a
 * fresh owner approval is always seen by the next run.
 */
export function cachedGithub(
  db: DrizzleSqliteDODatabase,
  github: GithubClient,
  freshAfter: number,
  now: () => number,
  onFetched: () => void
): GithubClient {
  const read = (key: string): { value: unknown; fetchedAt: number } | undefined =>
    db.select().from(githubCache).where(eq(githubCache.key, key)).get();
  const write = (key: string, value: unknown) => {
    const fetchedAt = now();
    db.insert(githubCache)
      .values({ key, value, fetchedAt })
      .onConflictDoUpdate({ target: githubCache.key, set: { value, fetchedAt } })
      .run();
    onFetched();
  };
  const remembered = async <T>(
    key: string,
    fetch: () => Promise<T>,
    keep: (value: T) => boolean = () => true,
    fresh: (fetchedAt: number) => boolean = () => true
  ): Promise<T> => {
    const hit = read(key);
    // The value was written by the same code path from a parsed GitHub answer.
    if (hit !== undefined && fresh(hit.fetchedAt)) return hit.value as T;
    const value = await fetch();
    if (keep(value)) write(key, value);
    return value;
  };

  return {
    compare: (base, head) => github.compare(base, head),
    blob: sha => github.blob(sha),
    tree: sha =>
      remembered<TreeEntry[] | null>(
        `tree:${sha}`,
        () => github.tree(sha),
        value => value !== null
      ),
    lastCommitTouching: (sha, path) =>
      remembered<string | null>(
        `commit:${sha}:${path}`,
        () => github.lastCommitTouching(sha, path),
        value => value !== null
      ),
    pullsOfCommit: commit =>
      remembered<PullSummary[]>(
        `pulls:${commit}`,
        () => github.pullsOfCommit(commit),
        value =>
          value.filter(pull => pull.mergedAt !== null && pull.baseRef === 'main').length === 1
      ),
    reviews: pr =>
      remembered<Review[]>(
        `reviews:${pr}`,
        () => github.reviews(pr),
        () => true,
        fetchedAt => fetchedAt >= freshAfter
      ),
    blobAt: (ref, path) =>
      remembered<{ blob: string | null }>(`contents:${ref}:${path}`, async () => ({
        blob: await github.blobAt(ref, path),
      })).then(value => value.blob),
  };
}

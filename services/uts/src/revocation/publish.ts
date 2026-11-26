import { UTS_FEED_COUNT } from '@kilocode/uts-contracts';
import { DEFAULT_DO_RETRY_CONFIG, withDORetry } from '@kilocode/worker-utils';
import type { WaitUntil } from '../db/client';
import { getFeedStub } from '../dos/stubs';
import type { Env, UtsConfig } from '../env';
import type { FeedPublishResult } from '../feed/UtsFeedDO';
import type { FeedEntry } from './entries';

/**
 * Each write to a feed object, retries included, ends by this deadline. A revoke answers once one
 * object confirmed, so this bounds how long it waits when both fail.
 */
export const FEED_PUBLISH_DEADLINE_MS = 2 * 1000;

/**
 * `published`: at least one feed object holds every entry. `unpublished`: neither confirmed in
 * time; the revocation stands in the identity store, and each object's backfill adds the entries
 * within its next runs (design 5.6).
 */
export type PublishOutcome = 'published' | 'unpublished';

/** Writes the feed entries of one committed statement to both feed objects. */
export type FeedPublish = (entries: readonly FeedEntry[]) => Promise<PublishOutcome>;

/**
 * The publisher of the mint Worker (design 5.6, "Publishing"): after the identity-store statement
 * commits, it writes the statement's entries to both feed objects in parallel and answers once one
 * confirms. The other write finishes in `waitUntil`. An empty batch writes nothing. A failed or
 * refused write is logged by kind and count, never by id.
 */
export function feedPublisher(env: Env, config: UtsConfig, context: WaitUntil): FeedPublish {
  return async entries => {
    if (entries.length === 0) return 'published';
    const deadlineAt = Date.now() + FEED_PUBLISH_DEADLINE_MS;
    const writes = Array.from({ length: UTS_FEED_COUNT }, async (_, feed) => {
      const result = await withDORetry(
        () => getFeedStub(env, config, feed),
        async (stub): Promise<FeedPublishResult> => {
          // Partial: only a workerd RPC result carries a disposer.
          const answered: FeedPublishResult & Partial<Disposable> = await stub.publish(entries);
          try {
            return { ...answered };
          } finally {
            answered[Symbol.dispose]?.();
          }
        },
        'uts.feed.publish',
        { ...DEFAULT_DO_RETRY_CONFIG, scope: { deadlineAt } }
      );
      if (result.status !== 'stored') {
        throw new Error(`feed ${feed} answered ${result.status}: ${result.reason}`);
      }
    });
    context.waitUntil(Promise.allSettled(writes));
    try {
      await Promise.any(writes);
      return 'published';
    } catch (error) {
      const kinds = [...new Set(entries.map(entry => entry.kind))];
      console.error(
        JSON.stringify({
          event: 'uts.feed.publish_failed',
          kinds,
          entries: entries.length,
          errors: error instanceof AggregateError ? error.errors.map(String) : [String(error)],
        })
      );
      return 'unpublished';
    }
  };
}

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
 * `published`: at least one feed object that vouches for its list (it backfilled in the last 30
 * seconds, so its heads count) holds every entry. `unpublished`: none did in time; the
 * revocation stands in the identity store, and each object's backfill adds the entries within its
 * next runs (design 5.6).
 */
export type PublishOutcome = 'published' | 'unpublished';

/** Writes the feed entries of one committed statement to both feed objects. */
export type FeedPublish = (entries: readonly FeedEntry[]) => Promise<PublishOutcome>;

/**
 * The publisher of the mint Worker (design 5.6, "Publishing"): after the identity-store statement
 * commits, it writes the statement's entries to both feed objects in parallel and answers once a
 * vouching object confirms. The other write finishes in `waitUntil`. An empty batch writes
 * nothing. A failed or refused write is logged by kind and count, never by id; a batch that only
 * objects without a fresh backfill took logs `uts.feed.publish_unvouched`, the alert that the
 * feed's backfill is failing.
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
      if (!result.vouching) throw new UnvouchedFeed(feed);
    });
    context.waitUntil(Promise.allSettled(writes));
    try {
      await Promise.any(writes);
      return 'published';
    } catch (error) {
      const kinds = [...new Set(entries.map(entry => entry.kind))];
      const failures = error instanceof AggregateError ? error.errors : [error];
      const unvouched = failures.every(failure => failure instanceof UnvouchedFeed);
      console.error(
        JSON.stringify({
          event: unvouched ? 'uts.feed.publish_unvouched' : 'uts.feed.publish_failed',
          kinds,
          entries: entries.length,
          errors: failures.map(String),
        })
      );
      return 'unpublished';
    }
  };
}

/** A feed object that took the entries but signs no head, because its backfill is not fresh. */
class UnvouchedFeed extends Error {
  constructor(feed: number) {
    super(`feed ${feed} holds the entries but vouches for no list`);
    this.name = 'UnvouchedFeed';
  }
}

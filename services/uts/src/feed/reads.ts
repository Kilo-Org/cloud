import {
  FeedReadsHeadSchema,
  FeedReadsListSchema,
  UtsFeedIndexSchema,
  type FeedReadsBinding,
  type FeedReadsHead,
  type FeedReadsList,
} from '@kilocode/uts-contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { DEFAULT_DO_RETRY_CONFIG, withDORetry } from '@kilocode/worker-utils';
import type { z } from 'zod';
import { callerOf } from '../callers';
import { getFeedStub } from '../dos/stubs';
import { FEED_DEPLOYMENTS, readConfig, type Env, type UtsConfig } from '../env';
import type { UtsFeedDO } from './UtsFeedDO';

/**
 * Each call to a feed object, retries included, ends by this deadline: before the feed Worker
 * gives the object up after 1 second (design 5.6), so a failed call reaches it as an answer.
 */
export const FEED_OBJECT_CALL_DEADLINE_MS = 800;

type Refused = { status: 'refused' };

/**
 * Runs one call on feed object `feed` for the binding whose props are `props`. Only the feed
 * Worker of this environment is answered; a feed index outside the two is the caller's deploy
 * error. The result is validated against its contract and copied out of the RPC result, which is
 * then disposed. A call that fails until its deadline is `unavailable`.
 */
async function feedCall<Schema extends z.ZodType<FeedReadsHead | FeedReadsList>>(
  env: Env,
  config: UtsConfig,
  props: unknown,
  feed: unknown,
  schema: Schema,
  name: string,
  call: (stub: DurableObjectStub<UtsFeedDO>) => Promise<unknown>
): Promise<z.output<Schema> | Refused | { status: 'misconfigured' } | { status: 'unavailable' }> {
  const caller = callerOf(props);
  if (caller !== FEED_DEPLOYMENTS[config.environment]) {
    console.warn(JSON.stringify({ event: 'uts.feed_reads.refused', caller }));
    return { status: 'refused' };
  }
  const index = UtsFeedIndexSchema.safeParse(feed);
  if (!index.success) return { status: 'misconfigured' };
  try {
    return await withDORetry(
      () => getFeedStub(env, config, index.data),
      async stub => {
        const result = await call(stub);
        try {
          return schema.parse(result);
        } finally {
          if (typeof result === 'object' && result !== null && Symbol.dispose in result) {
            const dispose = result[Symbol.dispose];
            if (typeof dispose === 'function') dispose.call(result);
          }
        }
      },
      name,
      {
        ...DEFAULT_DO_RETRY_CONFIG,
        scope: { deadlineAt: Date.now() + FEED_OBJECT_CALL_DEADLINE_MS },
      }
    );
  } catch (error) {
    console.error(
      JSON.stringify({ event: `${name}_failed`, feed: index.data, error: String(error) })
    );
    return { status: 'unavailable' };
  }
}

/**
 * The named entrypoint through which the feed Worker reads the two feed objects
 * (`UTS_FEED_READS_ENTRYPOINT`), bound with the feed Worker's deployed name as `props.caller`.
 * It reads only; writes come from the mint Worker's own revoking statements
 * (src/revocation/publish.ts), and no other Worker binds the feed objects. Placement does not
 * apply to a named entrypoint, so it runs where the feed Worker runs.
 */
export class FeedReads extends WorkerEntrypoint<Env> implements FeedReadsBinding {
  async head(feed: unknown): Promise<FeedReadsHead> {
    return await feedCall(
      this.env,
      readConfig(this.env),
      this.ctx.props,
      feed,
      FeedReadsHeadSchema,
      'uts.feed_reads.head',
      stub => stub.head()
    );
  }

  async list(feed: unknown, listHash: unknown): Promise<FeedReadsList> {
    return await feedCall(
      this.env,
      readConfig(this.env),
      this.ctx.props,
      feed,
      FeedReadsListSchema,
      'uts.feed_reads.list',
      stub => stub.list(listHash)
    );
  }
}

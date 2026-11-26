import type {
  FeedReaderBinding,
  FeedReaderBootstrap,
  FeedReaderHead,
  FeedReaderList,
} from '@kilocode/uts-contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { serveBootstrap } from './bootstrap';
import { readConfig, type Env } from './env';
import { FEED_RETRY_AFTER_SECONDS, serveHead, serveList } from './revocation';

/**
 * A caller names itself with its deployed Worker name, as STS names a workload. `test/repo`
 * (services/uts) requires every binding of this entrypoint to carry its own deployed name, so a
 * reader cannot pose as another.
 */
const CallerPropsSchema = z.strictObject({ caller: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) });

const UNAVAILABLE = { status: 'unavailable', retryAfterSeconds: FEED_RETRY_AFTER_SECONDS } as const;

/**
 * The named entrypoint Worker verifiers bind for the revocation feed and the bootstrap
 * (`UTS_FEED_READER_ENTRYPOINT`), the transport of `feedReaderSources` in
 * `@kilocode/uts-contracts`. Each method answers plain data; a binding without a valid
 * `props.caller` is refused. Any failure to read answers `unavailable` with the 5-second wait, as
 * the HTTPS routes answer 503 (design 7: a missing feed blocks only requests that need it).
 */
export class FeedReader extends WorkerEntrypoint<Env> implements FeedReaderBinding {
  #admitted(method: string): boolean {
    const props = CallerPropsSchema.safeParse(this.ctx.props);
    if (!props.success) {
      console.warn(JSON.stringify({ event: 'uts_feed.reader.refused', method }));
    }
    return props.success;
  }

  async head(): Promise<FeedReaderHead> {
    if (!this.#admitted('head')) return { status: 'refused' };
    const read = await serveHead(this.env.UTS_FEED_READS, readConfig(this.env), this.ctx);
    return read.status === 'ok' ? { status: 'ok', head: read.head } : UNAVAILABLE;
  }

  async list(listHash: unknown): Promise<FeedReaderList> {
    if (!this.#admitted('list')) return { status: 'refused' };
    const read = await serveList(this.env.UTS_FEED_READS, readConfig(this.env), listHash, this.ctx);
    if (read.status === 'ok') return { status: 'ok', list: read.bytes };
    return read.status === 'not_found' ? { status: 'not_found' } : UNAVAILABLE;
  }

  async bootstrap(): Promise<FeedReaderBootstrap> {
    if (!this.#admitted('bootstrap')) return { status: 'refused' };
    const read = await serveBootstrap(this.env, readConfig(this.env), this.ctx);
    return read.status === 'ok'
      ? { status: 'ok', jwks: read.jwks, keyAges: read.keyAges, head: read.head, list: read.list }
      : UNAVAILABLE;
  }
}

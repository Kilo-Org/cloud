import type { FeedReadsHead, FeedReadsList } from '@kilocode/uts-contracts';
import { readConfig } from './env';
import {
  FEED_ALARM_INTERVAL_MS,
  UtsFeedDO,
  type FeedPublicKeysResult,
  type FeedPublishResult,
} from './feed/UtsFeedDO';

/**
 * The feed object of `wrangler dev -c wrangler.dev.jsonc` only (`src/dev-index.ts` exports it as
 * `UtsFeedDO`): the deployed object plus `devStop`, which makes every call fail and stops its alarm
 * work for a while, as a stopped object would, for the local end-to-end run of the feed's
 * fail-over (design 5.7 proof run: one feed object stopped for 90 seconds). No deployed bundle
 * holds it (`test/repo`), and `devStop` refuses outside development.
 */
export class DevUtsFeedDO extends UtsFeedDO {
  #stoppedUntil = 0;

  async devStop(until: number): Promise<'stopped' | 'refused'> {
    if (readConfig(this.env).environment !== 'development') return 'refused';
    this.#stoppedUntil = until;
    return 'stopped';
  }

  #failIfStopped(): void {
    if (Date.now() < this.#stoppedUntil) throw new Error('feed object stopped for the local run');
  }

  override async publicKeys(): Promise<FeedPublicKeysResult> {
    this.#failIfStopped();
    return await super.publicKeys();
  }

  override async head(): Promise<FeedReadsHead> {
    this.#failIfStopped();
    return await super.head();
  }

  override async list(listHash: unknown): Promise<FeedReadsList> {
    this.#failIfStopped();
    return await super.list(listHash);
  }

  override async publish(entries: unknown): Promise<FeedPublishResult> {
    this.#failIfStopped();
    return await super.publish(entries);
  }

  override async alarm(): Promise<void> {
    if (Date.now() < this.#stoppedUntil) {
      await this.ctx.storage.setAlarm(Date.now() + FEED_ALARM_INTERVAL_MS);
      return;
    }
    await super.alarm();
  }
}

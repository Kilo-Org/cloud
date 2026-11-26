import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { FeedReadsHeadSchema, FeedReadsListSchema, feedOfFeedKid } from '@kilocode/uts-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { feedOfObjectName, getFeedStub } from '../../src/dos/stubs';
import { FEED_ALARM_INTERVAL_MS, type UtsFeedDO } from '../../src/feed/UtsFeedDO';
import { feedPublisher } from '../../src/revocation/publish';
import { feedAnswer, resetKeySetShards } from './support';
import { grantEntry } from './oauth-support';
import { config, env } from './test-env';

/**
 * The feed objects in the Workers test pool. The pool's identity-store binding reaches no
 * database, so every backfill fails here: the objects hold entries but sign no head, which is the
 * fail-closed state; test/db runs the backfill statements and scripts/feed-e2e.ts the signed heads
 * against Postgres.
 */

const feedStub = (feed: number) => getFeedStub(env, config, feed);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('feed objects', () => {
  it('publish two keys each under their own feed kid, kept across a restart', async () => {
    for (const feed of [0, 1]) {
      const first = await feedStub(feed).publicKeys();
      if (first.status !== 'ok') throw new Error(`feed ${feed} answered ${first.status}`);
      expect(first.feed).toBe(feed);
      expect(first.keys).toHaveLength(2);
      expect(first.keys.every(key => feedOfFeedKid(key.kid) === feed)).toBe(true);
      await runInDurableObject(feedStub(feed), (_instance, state) =>
        state.abort('test restart')
      ).catch(() => undefined);
      const again = await feedStub(feed).publicKeys();
      expect(again).toEqual(first);
    }
  });

  it('keep the 5-second alarm that runs the backfill', async () => {
    await feedStub(0).publicKeys();
    const alarm = await runInDurableObject(feedStub(0), (_instance, state) =>
      state.storage.getAlarm()
    );
    expect(alarm).not.toBeNull();
    expect(alarm ?? 0).toBeLessThanOrEqual(Date.now() + FEED_ALARM_INTERVAL_MS);
  });

  it('take a valid batch, refuse anything else, and sign no head without a good backfill', async () => {
    const stub = feedStub(1);
    expect(await stub.publish([grantEntry()])).toEqual({ status: 'stored', vouching: false });
    expect(await stub.publish([{ kind: 'grant', id: 'x' }])).toEqual({
      status: 'refused',
      reason: 'invalid_entries',
    });
    expect(await stub.publish('not a batch')).toMatchObject({ status: 'refused' });
    await runInDurableObject(stub, async (instance: UtsFeedDO) => {
      await instance.alarm();
    });
    expect(await stub.head()).toEqual({ status: 'unavailable' });
    expect(await stub.list('A'.repeat(43))).toEqual({ status: 'not_found' });
    expect(await stub.list('not a hash')).toEqual({ status: 'not_found' });
  });

  it('refuse to load under another name and answer every call misconfigured', async () => {
    const namespace = env.UTS_FEED_DO;
    const stray = namespace.get(namespace.idFromName('development:feed:7'));
    expect(feedOfObjectName('development', 'development:feed:7')).toBeNull();
    expect(await stray.publicKeys()).toMatchObject({ status: 'misconfigured' });
    expect(await stray.head()).toEqual({ status: 'misconfigured' });
    expect(await stray.publish([grantEntry()])).toMatchObject({ status: 'misconfigured' });
    const staging = namespace.get(namespace.idFromName('staging:feed:0'));
    expect(await staging.publicKeys()).toMatchObject({ status: 'misconfigured' });
  });

  it('reach the UTS key set through the key-set shards', async () => {
    await resetKeySetShards();
    const answer = await feedAnswer();
    expect(answer.feeds?.map(entry => entry.feed)).toEqual([0, 1]);
    for (const entry of answer.feeds ?? []) {
      if (entry.status !== 'ok') throw new Error(`feed ${entry.feed} answered ${entry.status}`);
      expect(entry.keys.every(key => feedOfFeedKid(key.kid) === entry.feed)).toBe(true);
    }
  });
});

describe('feed publisher', () => {
  it('answers unpublished and logs the unvouched alert when the objects hold the entries but sign nothing', async () => {
    // The pool's identity store is unreachable, so no feed object backfills or vouches.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const publish = feedPublisher(env, config, ctx);
    expect(await publish([grantEntry(), grantEntry()])).toBe('unpublished');
    expect(await publish([])).toBe('published');
    await waitOnExecutionContext(ctx);
    const logged = errors.mock.calls.map(call => String(call[0])).join('\n');
    expect(logged).toContain('"event":"uts.feed.publish_unvouched"');
    expect(await feedStub(0).publish([grantEntry()])).toEqual({
      status: 'stored',
      vouching: false,
    });
  });

  it('answers unpublished, logging kinds and counts only, when neither object takes the batch', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const publish = feedPublisher(env, config, ctx);
    const oversized = { ...grantEntry('id-in-no-log'), id: 'x'.repeat(256) };
    expect(await publish([oversized])).toBe('unpublished');
    await waitOnExecutionContext(ctx);
    const logged = errors.mock.calls.map(call => String(call[0])).join('\n');
    expect(logged).toContain('"event":"uts.feed.publish_failed"');
    expect(logged).toContain('"kinds":["grant"],"entries":1');
    expect(logged).not.toContain('x'.repeat(256));
  });
});

describe('FeedReads entrypoint', () => {
  it('answers the feed Worker with each object, and refuses a feed index outside the two', async () => {
    expect(FeedReadsHeadSchema.parse(await env.FEED_READS.head(0))).toEqual({
      status: 'unavailable',
    });
    expect(FeedReadsHeadSchema.parse(await env.FEED_READS.head(5))).toEqual({
      status: 'misconfigured',
    });
    expect(FeedReadsListSchema.parse(await env.FEED_READS.list(1, 'A'.repeat(43)))).toEqual({
      status: 'not_found',
    });
  });

  it('refuses every other caller without a call to a feed object', async () => {
    expect(await env.OTHER_READS.head(0)).toEqual({ status: 'refused' });
    expect(await env.OTHER_READS.list(0, 'A'.repeat(43))).toEqual({ status: 'refused' });
  });
});

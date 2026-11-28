import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { JWKS_PATH } from '@kilocode/sts-contracts';
import { bytesToBase64url } from '@kilocode/worker-utils/base64url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOKEN_JWKS_CACHE_MS,
  TOKEN_KEY_PUBLISH_AHEAD_MS,
  TOKEN_KEY_SET_REFRESH_AHEAD_MS,
  TOKEN_KEY_SET_RETRY_MS,
  TOKEN_SIGNER_SHARDS,
} from '../../src/constants';
import { getTokenKeySetStub, getTokenSignerStub } from '../../src/dos/stubs';
import {
  DOCUMENT_PREFIX,
  TokenKeySetDO,
  documentName,
  type TokenKeySetRead,
} from '../../src/dos/TokenKeySetDO';
import { TokenSignerDO } from '../../src/dos/TokenSignerDO';
import { handleRequest } from '../../src/http';
import type { KeyRing, TokenJwk } from '../../src/tokens/key-ring';
import { stubOfflineNetwork } from './manager';
import { resetTokenKeySetObject, resetTokenSignerObject } from './reset';
import { config, env } from './test-env';

const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_FIELDS = ['alg', 'crv', 'kid', 'kty', 'use', 'x'];

const keySet = () => getTokenKeySetStub(env, config);
const shard = (index: number) => getTokenSignerStub(env, config, index);
const shardIndexes = Array.from({ length: TOKEN_SIGNER_SHARDS }, (_, index) => index);

type StoredDocument = {
  keys: TokenJwk[];
  revokedKids: string;
  builtAt: number;
  stale: boolean;
  read: boolean;
};

beforeEach(async () => {
  stubOfflineNetwork();
  for (const index of shardIndexes) await resetTokenSignerObject(shard(index));
  await resetTokenKeySetObject(keySet());
});

afterEach(async () => {
  vi.restoreAllMocks();
  // No key-set alarm may fire after the file's storage is gone (see setup.ts).
  await runInDurableObject(keySet(), (_instance, state) => state.storage.deleteAlarm());
});

/** A well-formed kid no ring holds: each test's list differs, so no isolate copy answers it. */
function unusedKid(): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The key set as STS served it before the key-set object: every shard's keys, in shard order. */
async function perShardKeys(revoked: readonly string[]): Promise<TokenJwk[]> {
  const keys: TokenJwk[] = [];
  for (const index of shardIndexes) {
    const jwks = await shard(index).getJwks();
    keys.push(...jwks.keys.map(key => ({ ...key })));
  }
  return keys.filter(key => !revoked.includes(key.kid));
}

async function served(revoked: readonly string[]) {
  const response = await handleRequest(
    new Request(`${config.issuer}${JWKS_PATH}`),
    { ...env, TOKEN_SIGNING_KIDS_REVOKED: revoked.join(',') },
    createExecutionContext()
  );
  const body = await response.json<{ keys?: TokenJwk[] }>();
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    keys: body.keys ?? [],
  };
}

async function read(revoked: readonly string[] = []): Promise<TokenJwk[]> {
  const result: TokenKeySetRead = await keySet().read([...revoked]);
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
  return result.keys.map(key => ({ ...key }));
}

const kids = (keys: readonly TokenJwk[]) => keys.map(key => key.kid);

async function storedDocument(revoked: readonly string[] = []) {
  const name = await documentName(revoked.join(','));
  return runInDurableObject(keySet(), (_instance, state) =>
    state.storage.get<StoredDocument>(name)
  );
}

function storedLists(): Promise<string[]> {
  return runInDurableObject(keySet(), async (_instance, state) =>
    [...(await state.storage.list<StoredDocument>({ prefix: DOCUMENT_PREFIX })).values()].map(
      document => document.revokedKids
    )
  );
}

function storedAlarm(): Promise<number | null> {
  return runInDurableObject(keySet(), (_instance, state) => state.storage.getAlarm());
}

/**
 * Rewrites one shard's stored ring, restarts the shard, and has it apply what is due, as its alarm
 * would; the shard then tells the key-set object before it answers. Returns the shard's keys.
 */
async function changeRing(index: number, rewrite: (ring: KeyRing) => KeyRing): Promise<string[]> {
  await runInDurableObject(shard(index), async (_instance, state) => {
    const ring = await state.storage.get<KeyRing>('token-key-ring');
    if (ring === undefined) throw new Error('expected a stored ring');
    await state.storage.put('token-key-ring', rewrite(ring));
  });
  await runInDurableObject(shard(index), (_instance, state) => state.abort('restart')).catch(
    () => undefined
  );
  return kids((await shard(index).getJwks()).keys);
}

/** The current key of the ring is `ageMs` old, as is everything else in it. */
function aged(ring: KeyRing, ageMs: number): KeyRing {
  return {
    keys: ring.keys.map(key => ({
      ...key,
      createdAt: key.createdAt - ageMs,
      activatesAt: key.activatesAt - ageMs,
    })),
  };
}

describe('token key-set object', () => {
  it('serves the same key set as the per-shard read, with public fields only', async () => {
    const before = await perShardKeys([]);
    expect(before).toHaveLength(TOKEN_SIGNER_SHARDS);

    const plain = await served([unusedKid()]);
    expect(plain).toMatchObject({ status: 200, cacheControl: 'no-store' });
    expect(plain.keys).toEqual(before);

    // A listed kid is left out of the answer exactly as before.
    const listed = before[2].kid;
    const filtered = await served([listed]);
    expect(filtered.keys).toEqual(await perShardKeys([listed]));
    expect(kids(filtered.keys)).not.toContain(listed);

    for (const key of [...plain.keys, ...filtered.keys]) {
      expect(Object.keys(key).sort()).toEqual(PUBLIC_FIELDS);
    }
    // The stored document holds the same public fields and nothing else.
    const stored = await storedDocument([listed]);
    expect(stored?.keys.length).toBeGreaterThan(0);
    for (const key of stored?.keys ?? []) expect(Object.keys(key).sort()).toEqual(PUBLIC_FIELDS);
    expect(JSON.stringify(stored)).not.toMatch(/"d"|pkcs8/);
  });

  it('copies only public fields from a shard answer', async () => {
    const getJwks = TokenSignerDO.prototype.getJwks;
    vi.spyOn(TokenSignerDO.prototype, 'getJwks').mockImplementation(async function (
      this: TokenSignerDO
    ) {
      const jwks = await getJwks.call(this);
      // As if a shard leaked private material into its answer.
      return { keys: jwks.keys.map(key => ({ ...key, d: 'private-scalar', pkcs8: 'private' })) };
    });
    const keys = await read();
    expect(keys).toHaveLength(TOKEN_SIGNER_SHARDS);
    for (const key of keys) expect(Object.keys(key).sort()).toEqual(PUBLIC_FIELDS);
    expect(JSON.stringify(await storedDocument())).not.toMatch(/private/);
  });

  it('makes one object call per isolate-copy miss and no shard call while its document is fresh', async () => {
    const reads = vi.spyOn(TokenKeySetDO.prototype, 'read');
    const shardReads = vi.spyOn(TokenSignerDO.prototype, 'getJwks');

    // A list no isolate copy holds: one call to the key-set object, which builds its document.
    const list = [unusedKid()];
    expect((await served(list)).status).toBe(200);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(shardReads).toHaveBeenCalledTimes(TOKEN_SIGNER_SHARDS);

    // A restarted object answers from its stored document: still no shard call.
    await runInDurableObject(keySet(), (_instance, state) => state.abort('restart')).catch(
      () => undefined
    );
    shardReads.mockClear();
    const restarted = kids(await read(list));
    expect(shardReads).not.toHaveBeenCalled();
    expect(restarted).toEqual(kids(await perShardKeys(list)));
  });

  it('shares one rebuild between concurrent reads', async () => {
    const shardReads = vi.spyOn(TokenSignerDO.prototype, 'getJwks');
    const [first, second] = await Promise.all([read(), read()]);
    expect(second).toEqual(first);
    expect(shardReads).toHaveBeenCalledTimes(TOKEN_SIGNER_SHARDS);
  });

  it('marks a build stale when a shard changes after it answered, and no isolate keeps it', async () => {
    const getJwks = TokenSignerDO.prototype.getJwks;
    let shard0Answered = false;
    let changed = false;
    vi.spyOn(TokenSignerDO.prototype, 'getJwks').mockImplementation(async function (
      this: TokenSignerDO
    ) {
      const jwks = await getJwks.call(this);
      const { ctx } = this as unknown as { ctx: DurableObjectState };
      if (ctx.id.equals(shard(0).id)) {
        shard0Answered = true;
      } else if (ctx.id.equals(shard(1).id) && !changed) {
        // Shard 0 changes its ring after its answer reached the build, once.
        while (!shard0Answered) await scheduler.wait(5);
        await scheduler.wait(20);
        changed = true;
        await keySet().invalidate(0);
      }
      return jwks;
    });
    const reads = vi.spyOn(TokenKeySetDO.prototype, 'read');
    const list = [unusedKid()];

    expect((await served(list)).keys).toHaveLength(TOKEN_SIGNER_SHARDS);
    expect(changed).toBe(true);
    expect((await storedDocument(list))?.stale).toBe(true);
    // The isolate did not keep the stale set: the next request asks the object again, which
    // rebuilds; that clean set is kept.
    expect((await served(list)).status).toBe(200);
    expect(reads).toHaveBeenCalledTimes(2);
    expect((await storedDocument(list))?.stale).toBe(false);
    expect((await served(list)).status).toBe(200);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('shows a publication at the next read', async () => {
    const before = kids(await read());
    // Shard 1's current key is 24 days old: its next key is due for publication.
    const published = await changeRing(1, ring => aged(ring, 24 * DAY_MS));
    expect(published).toHaveLength(2);
    const after = kids(await read());
    expect(after).toEqual(expect.arrayContaining(published));
    expect(after).toHaveLength(before.length + 1);
    expect(after).toEqual(kids(await perShardKeys([])));
  });

  it('shows an activation and a retired key leaving its ring at the next read', async () => {
    await changeRing(1, ring => aged(ring, 24 * DAY_MS));
    const published = kids(await read());
    // The next key's activation is due: the current key retires and stays published.
    const activated = await changeRing(1, ring => aged(ring, TOKEN_KEY_PUBLISH_AHEAD_MS));
    expect(activated).toHaveLength(2);
    expect(kids(await read())).toEqual(published);

    // The retired key's last token expired more than the clock skew ago: it leaves the ring.
    let retiredKid = '';
    const remaining = await changeRing(1, ring => ({
      keys: ring.keys.map(key => {
        if (key.state !== 'retired') return key;
        retiredKid = key.kid;
        return { ...key, retiredAt: Date.now() - 10 * 60_000, maxExp: 0 };
      }),
    }));
    expect(remaining).toHaveLength(1);
    const after = kids(await read());
    expect(after).not.toContain(retiredKid);
    expect(after).toEqual(kids(await perShardKeys([])));
  });

  it('shows an emergency removal and its replacement at the next read under the new list', async () => {
    const list = [unusedKid()];
    const before = await served(list);
    const revoked = before.keys[2].kid;
    // The shard's change note is lost: the new list alone must rebuild the document.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(TokenKeySetDO.prototype, 'invalidate').mockRejectedValue(new Error('note lost'));

    // The deploy that lists the kid restarts shard 2 with the new list: it drops the key and
    // promotes a fresh one.
    await runInDurableObject(shard(2), async (_instance, state) => {
      const restarted = new TokenSignerDO(state, { ...env, TOKEN_SIGNING_KIDS_REVOKED: revoked });
      await restarted.getJwks();
      state.abort('restart');
    }).catch(() => undefined);
    const [replacement] = kids((await shard(2).getJwks()).keys);
    expect(replacement).not.toBe(revoked);

    const after = await served([...list, revoked]);
    expect(after.status).toBe(200);
    expect(kids(after.keys)).toContain(replacement);
    // The object's own document for the new list, not just the Worker's filter, lacks the kid.
    const document = await storedDocument([...list, revoked]);
    expect(kids(document?.keys ?? [])).toContain(replacement);
    expect(kids(document?.keys ?? [])).not.toContain(revoked);
  });

  it('expires its document one period after the shard reads when a change note is lost', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(TokenKeySetDO.prototype, 'invalidate').mockRejectedValue(new Error('note lost'));
    const before = kids(await read());
    const builtAt = (await storedDocument())?.builtAt ?? 0;

    const published = await changeRing(3, ring => aged(ring, 24 * DAY_MS));
    // Not told: the document still serves, inside its period.
    expect(kids(await read())).toEqual(before);

    vi.spyOn(Date, 'now').mockReturnValue(builtAt + TOKEN_JWKS_CACHE_MS);
    expect(kids(await read())).toEqual(expect.arrayContaining(published));
  });

  it('keeps an isolate copy no longer than one period after the shard reads', async () => {
    const reads = vi.spyOn(TokenKeySetDO.prototype, 'read');
    const list = [unusedKid()];
    await read(list);
    const builtAt = (await storedDocument(list))?.builtAt ?? 0;
    reads.mockClear();
    const clock = vi.spyOn(Date, 'now');

    // Four minutes on, an isolate without a copy reads the four-minute-old document.
    clock.mockReturnValue(builtAt + 4 * 60_000);
    expect((await served(list)).status).toBe(200);
    expect(reads).toHaveBeenCalledTimes(1);

    // Its copy serves until one period after the shard reads, not after its own call.
    clock.mockReturnValue(builtAt + TOKEN_JWKS_CACHE_MS - 1);
    expect((await served(list)).status).toBe(200);
    expect(reads).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(builtAt + TOKEN_JWKS_CACHE_MS);
    expect((await served(list)).status).toBe(200);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('schedules the refresh on a read and keeps the read mark across an eviction', async () => {
    await read();
    const builtAt = (await storedDocument())?.builtAt ?? 0;
    const refreshAt = builtAt + TOKEN_JWKS_CACHE_MS - TOKEN_KEY_SET_REFRESH_AHEAD_MS;
    expect(await storedAlarm()).toBe(refreshAt);
    expect((await storedDocument())?.read).toBe(true);

    // Evicted before the alarm: the new instance still refreshes, from the stored mark.
    await runInDurableObject(keySet(), (_instance, state) => state.abort('evicted')).catch(
      () => undefined
    );
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(refreshAt);
    await runInDurableObject(keySet(), instance => instance.alarm());
    expect((await storedDocument())?.builtAt).toBe(refreshAt);

    // No read since that rebuild: the next alarm leaves the document alone.
    clock.mockReturnValue(refreshAt + TOKEN_JWKS_CACHE_MS - TOKEN_KEY_SET_REFRESH_AHEAD_MS);
    await runInDurableObject(keySet(), instance => instance.alarm());
    expect((await storedDocument())?.builtAt).toBe(refreshAt);
  });

  it('retries a failed background rebuild until the document it replaces expires', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await read();
    const builtAt = (await storedDocument())?.builtAt ?? 0;
    // A stale document with no alarm, then every shard down.
    const name = await documentName('');
    await runInDurableObject(keySet(), async (_instance, state) => {
      const document = await state.storage.get<StoredDocument>(name);
      await state.storage.put(name, { ...document, stale: true });
      await state.storage.deleteAlarm();
      state.abort('restart');
    }).catch(() => undefined);
    vi.spyOn(TokenSignerDO.prototype, 'getJwks').mockRejectedValue(new Error('shard down'));

    const now = Date.now();
    await runInDurableObject(keySet(), instance => instance.alarm());
    expect(await storedAlarm()).toBeGreaterThanOrEqual(now + TOKEN_KEY_SET_RETRY_MS);
    await runInDurableObject(keySet(), (_instance, state) => state.storage.deleteAlarm());

    // Within one retry of the document's expiry, the alarm gives up.
    vi.spyOn(Date, 'now').mockReturnValue(builtAt + TOKEN_JWKS_CACHE_MS - 1_000);
    await runInDurableObject(keySet(), instance => instance.alarm());
    expect(await storedAlarm()).toBeNull();
  });

  it('keeps one document per revoked-kid list for the latest two lists', async () => {
    const [first, second, third] = [[unusedKid()], [unusedKid()], [unusedKid()]];
    await read(first);
    await read(second);
    const shardReads = vi.spyOn(TokenSignerDO.prototype, 'getJwks');
    // A rollout that alternates two lists rebuilds neither.
    await read(first);
    await read(second);
    await read(first);
    expect(shardReads).not.toHaveBeenCalled();
    expect((await storedLists()).sort()).toEqual([first[0], second[0]].sort());

    // A third list drops the oldest.
    await read(third);
    expect((await storedLists()).sort()).toEqual([second[0], third[0]].sort());
  });

  it('answers a stale document inside its period when a rebuild fails, and nothing after', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = kids(await read());
    const builtAt = (await storedDocument())?.builtAt ?? 0;
    // Every shard is down before the change note, so the alarm's rebuild fails too.
    vi.spyOn(TokenSignerDO.prototype, 'getJwks').mockRejectedValue(new Error('shard down'));
    await keySet().invalidate(0);
    expect((await storedDocument())?.stale).toBe(true);

    const fallback = await keySet().read([]);
    expect(fallback).toMatchObject({ status: 'ok', stale: true });
    expect(fallback.status === 'ok' ? kids(fallback.keys) : []).toEqual(before);
    vi.spyOn(Date, 'now').mockReturnValue(builtAt + TOKEN_JWKS_CACHE_MS);
    expect(await keySet().read([])).toEqual({ status: 'unavailable' });
    const answer = await served([unusedKid()]);
    expect(answer).toMatchObject({ status: 503, cacheControl: 'no-store' });
  });

  it('refuses a malformed list or shard', async () => {
    const outcome = await keySet()
      .read(['not-a-kid'])
      .then(
        () => 'answered',
        () => 'refused'
      );
    expect(outcome).toBe('refused');
    const shardOutcome = await keySet()
      .invalidate(TOKEN_SIGNER_SHARDS)
      .then(
        () => 'answered',
        () => 'refused'
      );
    expect(shardOutcome).toBe('refused');
  });
});

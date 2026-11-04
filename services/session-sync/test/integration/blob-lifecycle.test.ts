import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import { blobs } from '../../src/db/sqlite-schema';
import { getSessionSyncDOStub, type SessionSyncDO } from '../../src/dos/SessionSyncDO';
import * as batchOps from '../../src/dos/session-sync/batch';
import * as blobOps from '../../src/dos/session-sync/blob';
import type { Env } from '../../src/env';
import * as sessionOps from '../../src/dos/session-sync/session';
import { LIMITS, pageSchema, sessionStateSchema, type Principal } from '../../src/protocol';
import { batch, client, newSessionID, personal, sha256, testEnv } from '../helpers';

async function fixture() {
  const principal = personal(`usr-${crypto.randomUUID()}`);
  const api = client(principal);
  const sessionID = newSessionID();
  const sourceID = crypto.randomUUID();
  expect((await api.register(sessionID, sourceID)).status).toBe(201);
  const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  return { principal, api, sessionID, sourceID, stub };
}

async function begin(
  stub: DurableObjectStub<SessionSyncDO>,
  principal: Principal,
  sessionID: string,
  bytes: Uint8Array
) {
  const hash = await sha256(bytes);
  const input = { principal, sessionID, blob: { hash, bytes: bytes.byteLength } };
  const response = await stub.beginBlob(input);
  if (!response.ok || response.value.status !== 'upload')
    throw new Error('Expected upload admission');
  return { ...response.value, input: { ...input, attempt: response.value.attempt }, bytes };
}

async function expire(stub: DurableObjectStub<SessionSyncDO>) {
  await runInDurableObject(stub, (_instance, state) => {
    drizzle(state.storage)
      .update(blobs)
      .set({ deadline: Date.now() - blobOps.SWEEP_MARGIN_MS - 1000 })
      .where(isNotNull(blobs.hash))
      .run();
  });
}

async function store(
  upload: blobOps.Upload & { bytes: Uint8Array; input: { blob: { hash: string } } }
) {
  await testEnv.SESSION_SYNC_R2.put(upload.key, upload.bytes, { sha256: upload.input.blob.hash });
}

describe('blob attempt fencing', () => {
  it('rejects a second same-hash begin without refreshing the first deadline', async () => {
    const { principal, api, sessionID, stub } = await fixture();
    const bytes = new TextEncoder().encode('one admitted writer');
    const first = await begin(stub, principal, sessionID, bytes);
    const { attempt: _attempt, ...input } = first.input;
    const second = await stub.beginBlob(input);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toMatchObject({
        code: 'upload_in_progress',
        details: { retryAt: first.deadline + blobOps.SWEEP_MARGIN_MS },
      });
    }
    await runInDurableObject(stub, (_instance, state) => {
      const row = drizzle(state.storage)
        .select()
        .from(blobs)
        .where(eq(blobs.hash, input.blob.hash))
        .get();
      expect(row).toMatchObject({
        attempt: first.attempt,
        deadline: first.deadline,
        state: 'pending',
      });
    });
    await store(first);
    const committed = await stub.commitBlob(first.input);
    expect(committed.ok).toBe(true);
    expect(await stub.beginBlob(input)).toEqual({ ok: true, value: { status: 'ready' } });
    expect(await (await api.getBlob(sessionID, input.blob.hash)).text()).toBe(
      'one admitted writer'
    );
  });

  it('fences a cleanup claim before R2 deletion yields to another begin or commit', async () => {
    const { principal, api, sessionID, stub } = await fixture();
    const upload = await begin(
      stub,
      principal,
      sessionID,
      new TextEncoder().encode('expired writer')
    );
    await store(upload);
    await expire(stub);
    // Execute the alarm's claim boundary against real SQLite, then pause before
    // its real R2 delete to interleave a consumer request deterministically.
    const claims = await runInDurableObject(stub, (_instance, state) => {
      const db = drizzle(state.storage);
      const meta = sessionOps.load(db);
      if (!meta) throw new Error('Expected registered session');
      return state.storage.transactionSync(() => blobOps.claim(db, meta, Date.now()));
    });
    expect(claims).toEqual([
      { hash: upload.input.blob.hash, attempt: upload.attempt, key: upload.key },
    ]);
    const { attempt: _attempt, ...input } = upload.input;
    const competing = await stub.beginBlob(input);
    expect(competing.ok).toBe(false);
    if (!competing.ok) expect(competing.error.code).toBe('upload_in_progress');
    const staleCommit = await stub.commitBlob(upload.input);
    expect(staleCommit.ok).toBe(false);
    if (!staleCommit.ok) expect(staleCommit.error.code).toBe('upload_timeout');
    await testEnv.SESSION_SYNC_R2.delete(claims.map(row => row.key));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() =>
        blobOps.finish(drizzle(state.storage), claims, Date.now())
      );
    });
    const replacement = await begin(stub, principal, sessionID, upload.bytes);
    expect(replacement.key).not.toBe(upload.key);
    await store(replacement);
    expect((await stub.commitBlob(replacement.input)).ok).toBe(true);
    // Repeated stale cleanup cannot remove the replacement row or its object.
    await testEnv.SESSION_SYNC_R2.delete(claims.map(row => row.key));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() =>
        blobOps.finish(drizzle(state.storage), claims, Date.now())
      );
    });
    expect(await (await api.getBlob(sessionID, input.blob.hash)).text()).toBe('expired writer');
  });

  it('ignores a stale abort and confines a stale commit to the old physical key', async () => {
    const { principal, api, sessionID, sourceID, stub } = await fixture();
    const first = await begin(stub, principal, sessionID, new TextEncoder().encode('retry bytes'));
    await expire(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const second = await begin(stub, principal, sessionID, first.bytes);
    expect(second.attempt).not.toBe(first.attempt);
    expect((await stub.abortBlob(first.input)).ok).toBe(true);
    await store(second);
    expect((await stub.commitBlob(second.input)).ok).toBe(true);
    await store(first);
    const obsolete = await stub.commitBlob(first.input);
    expect(obsolete.ok).toBe(false);
    if (!obsolete.ok) expect(obsolete.error.code).toBe('upload_timeout');
    expect(await testEnv.SESSION_SYNC_R2.head(first.key)).toBeNull();
    expect(await testEnv.SESSION_SYNC_R2.head(second.key)).not.toBeNull();
    const applied = await api.apply(
      sessionID,
      batch(sourceID, 0, 1, [{ op: 'put', kind: 'asset', id: 'asset', blob: second.input.blob }])
    );
    expect(applied.status).toBe(200);
    expect(pageSchema.parse(await (await api.entities(sessionID)).json()).entities).toHaveLength(1);
    expect(await (await api.getBlob(sessionID, first.input.blob.hash)).text()).toBe('retry bytes');
  });

  it('retains an aborted attempt until its deadline and never lets it commit', async () => {
    const { principal, api, sessionID, stub } = await fixture();
    const upload = await begin(
      stub,
      principal,
      sessionID,
      new TextEncoder().encode('aborted bytes')
    );
    expect((await stub.abortBlob(upload.input)).ok).toBe(true);
    const { attempt: _attempt, ...input } = upload.input;
    const retry = await stub.beginBlob(input);
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      // The aborted row is claimable only after its admitted deadline.
      expect(retry.error).toMatchObject({
        code: 'upload_in_progress',
        details: { retryAt: upload.deadline + blobOps.SWEEP_MARGIN_MS },
      });
    }
    await store(upload);
    const commit = await stub.commitBlob(upload.input);
    expect(commit.ok).toBe(false);
    if (!commit.ok) expect(commit.error.code).toBe('upload_timeout');
    const state = sessionStateSchema.parse(await (await api.state(sessionID)).json());
    expect(state).toMatchObject({ usage: { blobBytes: upload.bytes.byteLength } });
    await expire(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await testEnv.SESSION_SYNC_R2.head(upload.key)).toBeNull();
    expect(sessionStateSchema.parse(await (await api.state(sessionID)).json())).toMatchObject({
      usage: { blobBytes: 0 },
    });
  });

  it('keeps the admitted deadline through deletion and cleans a disconnected late upload', async () => {
    const { principal, api, sessionID, stub } = await fixture();
    const upload = await begin(stub, principal, sessionID, new TextEncoder().encode('late PUT'));
    const { attempt: _attempt, ...input } = upload.input;
    const competing = await stub.beginBlob(input);
    expect(competing.ok).toBe(false);
    if (!competing.ok) expect(competing.error.code).toBe('upload_in_progress');
    expect((await api.remove(sessionID)).status).toBe(200);
    await runInDurableObject(stub, (_instance, state) => {
      const row = drizzle(state.storage).select().from(blobs).get();
      expect(row).toMatchObject({ attempt: upload.attempt, deadline: upload.deadline });
    });
    await store(upload);
    await expire(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await testEnv.SESSION_SYNC_R2.head(upload.key)).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect((await api.getBlob(sessionID, input.blob.hash)).status).toBe(410);
  });

  it('re-arms cleanup when a retry finds a reservation without an alarm', async () => {
    const { principal, sessionID, stub } = await fixture();
    const upload = await begin(stub, principal, sessionID, new TextEncoder().encode('lost alarm'));
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
    const { attempt: _attempt, ...input } = upload.input;
    const retry = await stub.beginBlob(input);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe('upload_in_progress');
    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())
    ).not.toBeNull();
  });
});

describe('bounded blob cleanup', () => {
  it('cleans more than a SQL parameter limit in bounded alarm pages and refunds quota', async () => {
    const { principal, api, sessionID, stub } = await fixture();
    const uploads = [];
    for (let index = 0; index < 130; index++) {
      const upload = await begin(stub, principal, sessionID, new Uint8Array([index]));
      await store(upload);
      uploads.push(upload);
    }
    await expire(stub);
    // Each alarm claims one bounded page and schedules the next one. Drain the
    // scheduled pages, then wait for a page the runtime may already be running.
    while (await runDurableObjectAlarm(stub));
    await expect
      .poll(async () => sessionStateSchema.parse(await (await api.state(sessionID)).json()))
      .toMatchObject({ usage: { blobBytes: 0 } });
    for (const upload of uploads) expect(await testEnv.SESSION_SYNC_R2.head(upload.key)).toBeNull();
  });

  it('counts empty blobs against the metadata budget', async () => {
    const { principal, sessionID, stub } = await fixture();
    // Use the real persistence boundary with synthetic rows to reach the quota
    // without issuing thousands of identical empty-content uploads.
    await runInDurableObject(stub, (_instance, state) => {
      const db = drizzle(state.storage);
      state.storage.transactionSync(() => {
        for (let index = 0; index < LIMITS.sessionBlobs; index++) {
          db.insert(blobs)
            .values({
              hash: index.toString(16).padStart(64, '0'),
              attempt: crypto.randomUUID(),
              bytes: 0,
              state: 'pending',
              deadline: Date.now() + LIMITS.uploadMs,
              created_at: Date.now(),
            })
            .run();
        }
      });
    });
    const result = await stub.beginBlob({
      principal,
      sessionID,
      blob: { hash: await sha256(new Uint8Array(0)), bytes: 0 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('storage_budget_exceeded');
  });
});

describe('unreferenced blob grace period', () => {
  it('reclaims a superseded blob and reports blob_missing on a later reference', async () => {
    const { principal, api, sessionID, sourceID, stub } = await fixture();
    const upload = await begin(stub, principal, sessionID, new TextEncoder().encode('old content'));
    await store(upload);
    expect((await stub.commitBlob(upload.input)).ok).toBe(true);
    const ref = upload.input.blob;
    expect(
      (
        await api.apply(
          sessionID,
          batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'm', blob: ref }])
        )
      ).status
    ).toBe(200);
    expect(
      (
        await api.apply(
          sessionID,
          batch(sourceID, 1, 2, [{ op: 'put', kind: 'message', id: 'm', value: 'replacement' }])
        )
      ).status
    ).toBe(200);
    await runInDurableObject(stub, (_instance, state) => {
      const row = drizzle(state.storage).select().from(blobs).get();
      expect(row).toMatchObject({ state: 'unreferenced' });
      expect(row!.deadline).toBeLessThanOrEqual(Date.now());
      expect(row!.deadline).toBeGreaterThan(Date.now() - 10_000);
    });
    expect((await api.getBlob(sessionID, ref.hash)).status).toBe(200);
    await expire(stub);
    await runDurableObjectAlarm(stub);
    expect(await testEnv.SESSION_SYNC_R2.head(upload.key)).toBeNull();
    const response = await api.apply(
      sessionID,
      batch(sourceID, 2, 3, [{ op: 'put', kind: 'message', id: 'm', blob: ref }])
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'blob_missing', details: { hash: ref.hash } },
    });
    expect(await (await api.state(sessionID)).json()).toMatchObject({ usage: { blobBytes: 0 } });
  });

  it('keeps a blob re-referenced within grace, including a same-batch transfer', async () => {
    const { principal, api, sessionID, sourceID, stub } = await fixture();
    const upload = await begin(
      stub,
      principal,
      sessionID,
      new TextEncoder().encode('reused content')
    );
    await store(upload);
    expect((await stub.commitBlob(upload.input)).ok).toBe(true);
    const ref = upload.input.blob;
    expect(
      (
        await api.apply(
          sessionID,
          batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'm', blob: ref }])
        )
      ).status
    ).toBe(200);
    expect(
      (
        await api.apply(
          sessionID,
          batch(sourceID, 1, 2, [{ op: 'remove', kind: 'message', id: 'm', cause: 'revert' }])
        )
      ).status
    ).toBe(200);
    expect(
      (
        await api.apply(
          sessionID,
          batch(sourceID, 2, 3, [
            { op: 'put', kind: 'message', id: 'new', blob: ref },
            { op: 'put', kind: 'message', id: 'other', blob: ref },
            { op: 'remove', kind: 'message', id: 'new', cause: 'revert' },
          ])
        )
      ).status
    ).toBe(200);
    await expire(stub);
    await runDurableObjectAlarm(stub);
    expect(await testEnv.SESSION_SYNC_R2.head(upload.key)).not.toBeNull();
    await runInDurableObject(stub, (_instance, state) => {
      expect(drizzle(state.storage).select().from(blobs).get()).toMatchObject({ state: 'ready' });
    });
  });
});

it('retains fresh uploads for grace and refreshes unreferenced upload hints', async () => {
  const { principal, sessionID, stub } = await fixture();
  const upload = await begin(stub, principal, sessionID, new TextEncoder().encode('new content'));
  await store(upload);
  expect((await stub.commitBlob(upload.input)).ok).toBe(true);
  await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage);
    const row = db.select().from(blobs).get()!;
    expect(row.state).toBe('unreferenced');
    expect(row.deadline).toBeGreaterThan(Date.now() + LIMITS.unreferencedMs - 10_000);
    db.update(blobs)
      .set({ deadline: Date.now() + 1000 })
      .where(eq(blobs.hash, row.hash))
      .run();
  });
  expect(await stub.beginBlob({ principal, sessionID, blob: upload.input.blob })).toMatchObject({
    ok: true,
    value: { status: 'ready' },
  });
  await runInDurableObject(stub, (_instance, state) => {
    expect(drizzle(state.storage).select().from(blobs).get()!.deadline).toBeGreaterThan(
      Date.now() + LIMITS.unreferencedMs - 10_000
    );
  });
});

it('bounds retained blob bytes during ten minutes of one-second supersessions', async () => {
  const { principal, sessionID, sourceID, stub } = await fixture();
  await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage);
    const bytes = 200 * 1024;
    const start = Date.now();
    let peak = 0;
    // Exercise real SQLite transitions with a logical clock. The lifecycle tests
    // above cover R2 deletion; these metadata-only fixtures have no physical objects.
    for (let index = 0; index < 600; index++) {
      const now = start + index * 1000;
      state.storage.transactionSync(() => {
        const ref = { hash: index.toString(16).padStart(64, '0'), bytes };
        const begun = blobOps.begin(db, principal, sessionID, ref, now);
        if (begun.status !== 'upload') throw new Error('Expected new upload');
        blobOps.commit(db, principal, sessionID, ref, begun.attempt, now);
        batchOps.apply(
          db,
          principal,
          sessionID,
          batch(sourceID, index, index + 1, [
            { op: 'put', kind: 'message', id: 'current', blob: ref },
          ]),
          ref.hash,
          now
        );
        peak = Math.max(peak, sessionOps.load(db)!.blob_bytes);
        const claimed = blobOps.claim(db, sessionOps.load(db)!, now);
        blobOps.finish(db, claimed, now);
      });
    }
    expect(peak).toBeLessThanOrEqual(62 * bytes);
    expect(sessionOps.load(db)!.blob_bytes).toBeLessThanOrEqual(61 * bytes);
    expect(peak).toBeLessThan(LIMITS.sessionBlobBytes);
  });
});

it('rejects a reference while a claimed blob is awaiting physical deletion', async () => {
  const { principal, api, sessionID, sourceID, stub } = await fixture();
  const upload = await begin(stub, principal, sessionID, new TextEncoder().encode('claim race'));
  await store(upload);
  expect((await stub.commitBlob(upload.input)).ok).toBe(true);
  await expire(stub);
  const claimed = await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage);
    return state.storage.transactionSync(() => blobOps.claim(db, sessionOps.load(db)!, Date.now()));
  });
  expect(claimed).toHaveLength(1);
  const response = await api.apply(
    sessionID,
    batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'm', blob: upload.input.blob }])
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { code: 'blob_missing', details: { hash: upload.input.blob.hash } },
  });
  const begun = await stub.beginBlob({ principal, sessionID, blob: upload.input.blob });
  expect(begun).toMatchObject({ ok: false, error: { code: 'upload_in_progress' } });
  if (begun.ok) throw new Error('A claimed hash must not be admitted');
  const retryAt = Number(begun.error.details?.retryAt);
  expect(retryAt).toBeGreaterThan(Date.now());
  expect(retryAt).toBeLessThanOrEqual(Date.now() + 5000);
  await testEnv.SESSION_SYNC_R2.delete(claimed.map(row => row.key));
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.transactionSync(() =>
      blobOps.finish(drizzle(state.storage), claimed, Date.now())
    );
  });
  expect(await (await api.state(sessionID)).json()).toMatchObject({
    position: 0,
    usage: { blobBytes: 0 },
  });
});

it('retains R2 cleanup backoff across mutations and early alarm invocations', async () => {
  const { principal, api, sessionID, sourceID, stub } = await fixture();
  const upload = await begin(stub, principal, sessionID, new TextEncoder().encode('R2 outage'));
  await store(upload);
  expect((await stub.commitBlob(upload.input)).ok).toBe(true);
  await expire(stub);
  await runInDurableObject(stub, instance => {
    // Fault injection is confined to this object's environment.
    const exposed = instance as unknown as { env: Env; deleteAttempts: number };
    exposed.deleteAttempts = 0;
    exposed.env = {
      ...exposed.env,
      SESSION_SYNC_R2: {
        delete: async () => {
          exposed.deleteAttempts++;
          throw new Error('Synthetic R2 outage');
        },
      } as unknown as R2Bucket,
    };
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const retryAt = await runInDurableObject(stub, (_instance, state) =>
    state.storage.get<number>('purgeRetryAt')
  );
  expect(retryAt).toBeGreaterThan(Date.now());
  expect(
    (
      await api.apply(
        sessionID,
        batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'm', value: 'still writable' }])
      )
    ).status
  ).toBe(200);
  expect(
    (
      await stub.beginBlob({
        principal,
        sessionID,
        blob: { hash: await sha256(new TextEncoder().encode('next')), bytes: 4 },
      })
    ).ok
  ).toBe(true);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await runInDurableObject(stub, async (instance, state) => {
    expect('deleteAttempts' in instance && instance.deleteAttempts).toBe(1);
    expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(retryAt!);
    expect(await state.storage.get('purgeRetryAt')).toBe(retryAt);
  });
});

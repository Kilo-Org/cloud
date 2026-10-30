import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import { blobs } from '../../src/db/sqlite-schema';
import { getSessionSyncDOStub, type SessionSyncDO } from '../../src/dos/SessionSyncDO';
import * as blobOps from '../../src/dos/session-sync/blob';
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

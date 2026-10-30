import { SELF, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import { blobs, receipts } from '../../src/db/sqlite-schema';
import { getSessionSyncDOStub, type SessionSyncDO } from '../../src/dos/SessionSyncDO';
import {
  LIMITS,
  blobAckSchema,
  errorBodySchema,
  pageSchema,
  receiptSchema,
  sessionStateSchema,
  type Entity,
} from '../../src/protocol';
import {
  batch,
  blobPrefix,
  client,
  type Client,
  member,
  newSessionID,
  personal,
  sha256,
  testEnv,
} from '../helpers';

async function errorCode(response: Response): Promise<string> {
  return errorBodySchema.parse(await response.json()).error.code;
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await errorCode(response)).toBe(code);
}

async function state(api: Client, id: string) {
  const response = await api.state(id);
  expect(response.status).toBe(200);
  return sessionStateSchema.parse(await response.json());
}

async function readAll(api: Client, id: string): Promise<Entity[]> {
  const entities: Entity[] = [];
  let cursor: string | null = null;
  let revision: number | undefined;
  do {
    const query: Record<string, string> = {};
    if (cursor) query.cursor = cursor;
    if (revision !== undefined) query.revision = String(revision);
    const response = await api.entities(id, query);
    expect(response.status).toBe(200);
    const page = pageSchema.parse(await response.json());
    revision = page.revision;
    entities.push(...page.entities);
    cursor = page.next;
  } while (cursor);
  return entities;
}

async function setup(principal = personal(`usr-${crypto.randomUUID()}`)) {
  const api = client(principal);
  const id = newSessionID();
  const sourceID = crypto.randomUUID();
  const response = await api.register(id, sourceID);
  expect(response.status).toBe(201);
  return { api, id, sourceID, principal };
}

async function upload(api: Client, id: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  const hash = await sha256(bytes);
  const response = await api.putBlob(id, hash, bytes);
  return { bytes, hash, response };
}

describe('authentication', () => {
  it('rejects data routes without a sync grant', async () => {
    const response = await SELF.fetch(`https://session-sync.test/v1/sessions/${newSessionID()}`);
    expect(response.status).toBe(401);
  });

  it('rejects a bearer token that is not a sync grant', async () => {
    const response = await SELF.fetch(`https://session-sync.test/v1/sessions/${newSessionID()}`, {
      headers: { authorization: 'Bearer not-a-grant' },
    });
    expect(response.status).toBe(401);
  });
});

describe('registration', () => {
  it('binds a session once and reports its committed state', async () => {
    const { api, id, sourceID, principal } = await setup();

    const again = await api.register(id, sourceID);
    expect(again.status).toBe(200);

    const current = await state(api, id);
    expect(current).toMatchObject({
      sessionID: id,
      deleted: false,
      creatorID: principal.userID,
      sourceID,
      position: 0,
      revision: 0,
      tenant: principal.tenant,
    });
  });

  it('refuses another source without replacing the binding', async () => {
    const { api, id, sourceID } = await setup();
    await expectError(await api.register(id, crypto.randomUUID()), 409, 'source_conflict');
    expect(await state(api, id)).toMatchObject({ sourceID });
  });

  it('accepts producer-defined session IDs that start with ses', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const api = client(principal);
    const id = `ses-custom_fixture.${crypto.randomUUID()}/part`;
    const sourceID = crypto.randomUUID();
    expect((await api.register(id, sourceID)).status).toBe(201);
    expect(await state(api, id)).toMatchObject({ sessionID: id });

    const { hash, response } = await upload(api, id, 'custom id bytes');
    expect(response.status).toBe(201);
    const listed = await testEnv.SESSION_SYNC_R2.list({ prefix: blobPrefix(principal, id) });
    expect(listed.objects).toHaveLength(1);
    expect(listed.objects[0]?.key.startsWith(`${blobPrefix(principal, id)}${hash}/`)).toBe(true);

    await expectError(await api.register('abc', sourceID), 400, 'invalid_request');
  });

  it('reports an unregistered session as absent', async () => {
    const api = client(personal(`usr-${crypto.randomUUID()}`));
    await expectError(await api.state(newSessionID()), 404, 'session_not_found');
  });
});

describe('batches', () => {
  it('applies changes atomically and reads them back', async () => {
    const { api, id, sourceID } = await setup();
    const response = await api.apply(
      id,
      batch(sourceID, 0, 7, [
        { op: 'put', kind: 'session', id: id, value: { title: 'Fix the parser' } },
        { op: 'put', kind: 'message', id: 'msg_1', value: { role: 'user', text: 'héllo' } },
      ])
    );
    expect(response.status).toBe(200);
    const receipt = receiptSchema.parse(await response.json());
    expect(receipt).toMatchObject({ after: 0, through: 7, revision: 1, changes: 2 });

    expect(await state(api, id)).toMatchObject({ position: 7, revision: 1, batches: 1 });
    expect(await readAll(api, id)).toEqual([
      { kind: 'message', id: 'msg_1', revision: 1, value: { role: 'user', text: 'héllo' } },
      { kind: 'session', id, revision: 1, value: { title: 'Fix the parser' } },
    ]);
  });

  it('returns the durable receipt for a repeated delivery without applying it again', async () => {
    const { api, id, sourceID } = await setup();
    const packet = batch(sourceID, 0, 3, [
      { op: 'put', kind: 'message', id: 'msg_1', value: { text: 'one' } },
    ]);
    const first = receiptSchema.parse(await (await api.apply(id, packet)).json());
    const second = await api.apply(id, packet);
    expect(second.status).toBe(200);
    expect(receiptSchema.parse(await second.json())).toEqual(first);

    expect(await state(api, id)).toMatchObject({ position: 3, revision: 1, batches: 1 });
  });

  it('treats a re-serialized packet as changed content', async () => {
    const { api, id, sourceID } = await setup();
    const packet = batch(sourceID, 0, 1, [
      { op: 'put', kind: 'message', id: 'msg_1', value: { a: 1, b: 2 } },
    ]);
    expect((await api.apply(id, packet)).status).toBe(200);
    const reordered = {
      changes: [{ value: { b: 2, a: 1 }, id: 'msg_1', kind: 'message', op: 'put' }],
      through: 1,
      after: 0,
      batchID: packet.batchID,
      sourceID,
      version: 1,
    };
    await expectError(await api.apply(id, reordered), 409, 'batch_conflict');
    expect(await state(api, id)).toMatchObject({ batches: 1 });
  });

  it('reports the last receipt with the digest of the exact body', async () => {
    const { api, id, sourceID } = await setup();
    expect(await state(api, id)).toMatchObject({ lastReceipt: null });

    const packet = batch(sourceID, 0, 4, [
      { op: 'put', kind: 'message', id: 'msg_1', value: { text: 'ünïcode' } },
    ]);
    const response = await api.apply(id, packet);
    const receipt = receiptSchema.parse(await response.json());
    expect(receipt.digest).toBe(await sha256(new TextEncoder().encode(JSON.stringify(packet))));

    const current = await state(api, id);
    expect(current).toMatchObject({ position: 4, lastReceipt: receipt });
  });

  it('refuses changed content under an acknowledged batch ID', async () => {
    const { api, id, sourceID } = await setup();
    const packet = batch(sourceID, 0, 3, [
      { op: 'put', kind: 'message', id: 'msg_1', value: { text: 'one' } },
    ]);
    expect((await api.apply(id, packet)).status).toBe(200);

    const changed = { ...packet, changes: [{ ...packet.changes[0], value: { text: 'two' } }] };
    await expectError(await api.apply(id, changed), 409, 'batch_conflict');
    expect(await readAll(api, id)).toEqual([
      { kind: 'message', id: 'msg_1', revision: 1, value: { text: 'one' } },
    ]);
  });

  it('refuses a predecessor mismatch and reports the committed position', async () => {
    const { api, id, sourceID } = await setup();
    expect((await api.apply(id, batch(sourceID, 0, 5, []))).status).toBe(200);

    const response = await api.apply(
      id,
      batch(sourceID, 4, 9, [{ op: 'put', kind: 'message', id: 'msg_1', value: 'lost' }])
    );
    expect(response.status).toBe(409);
    const body = errorBodySchema.parse(await response.json());
    expect(body.error).toMatchObject({ code: 'position_conflict', position: 5 });
    expect(await readAll(api, id)).toEqual([]);
    expect(await state(api, id)).toMatchObject({ position: 5, revision: 1 });
  });

  it('rolls back every change when a referenced blob is missing', async () => {
    const { api, id, sourceID } = await setup();
    const missing = await sha256(new TextEncoder().encode('never uploaded'));
    await expectError(
      await api.apply(
        id,
        batch(sourceID, 0, 2, [
          { op: 'put', kind: 'message', id: 'msg_1', value: 'first' },
          { op: 'put', kind: 'asset', id: 'asset_1', blob: { hash: missing, bytes: 14 } },
        ])
      ),
      409,
      'blob_missing'
    );
    expect(await readAll(api, id)).toEqual([]);
    expect(await state(api, id)).toMatchObject({ position: 0, revision: 0, batches: 0 });
  });

  it('refuses a batch from another source', async () => {
    const { api, id } = await setup();
    await expectError(
      await api.apply(id, batch(crypto.randomUUID(), 0, 1, [])),
      409,
      'source_conflict'
    );
  });

  it('removes entities with a semantic cause and never removes the session entity', async () => {
    const { api, id, sourceID } = await setup();
    await api.apply(
      id,
      batch(sourceID, 0, 1, [{ op: 'put', kind: 'inbox', id: 'in_1', value: { text: 'later' } }])
    );
    const removed = await api.apply(
      id,
      batch(sourceID, 1, 2, [{ op: 'remove', kind: 'inbox', id: 'in_1', cause: 'consumed' }])
    );
    expect(removed.status).toBe(200);
    expect(await readAll(api, id)).toEqual([]);
    expect(await state(api, id)).toMatchObject({ usage: { entities: 0, inlineBytes: 0 } });

    await expectError(
      await api.apply(id, {
        ...batch(sourceID, 2, 3, []),
        changes: [{ op: 'remove', kind: 'session', id, cause: 'revert' }],
      }),
      400,
      'invalid_request'
    );
  });

  it('refuses an expired retry instead of applying it over newer data', async () => {
    const { api, id, sourceID, principal } = await setup();
    const old = batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'msg_1', value: 'old' }]);
    expect((await api.apply(id, old)).status).toBe(200);
    expect(
      (
        await api.apply(
          id,
          batch(sourceID, 1, 2, [{ op: 'put', kind: 'message', id: 'msg_1', value: 'new' }])
        )
      ).status
    ).toBe(200);
    const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID: id });
    await runInDurableObject(stub, (_instance, state) => {
      drizzle(state.storage).delete(receipts).where(eq(receipts.batch_id, old.batchID)).run();
    });

    const retry = await api.apply(id, old);
    expect(retry.status).toBe(409);
    expect(errorBodySchema.parse(await retry.json()).error).toMatchObject({
      code: 'batch_superseded',
      position: 2,
    });
    expect(await readAll(api, id)).toEqual([
      { kind: 'message', id: 'msg_1', revision: 2, value: 'new' },
    ]);
  });

  it('enforces inline, change-count, and body bounds', async () => {
    const { api, id, sourceID } = await setup();
    const large = 'x'.repeat(LIMITS.inlineBytes);
    await expectError(
      await api.apply(
        id,
        batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'msg_1', value: large }])
      ),
      400,
      'invalid_request'
    );

    // Each two-byte character counts twice: the bound is UTF-8 bytes, not string length.
    const wide = 'é'.repeat(LIMITS.inlineBytes / 2);
    await expectError(
      await api.apply(
        id,
        batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'msg_1', value: wide }])
      ),
      400,
      'invalid_request'
    );

    const many = Array.from({ length: LIMITS.changes + 1 }, (_, index) => ({
      op: 'put' as const,
      kind: 'message' as const,
      id: `msg_${index}`,
      value: index,
    }));
    await expectError(await api.apply(id, batch(sourceID, 0, 1, many)), 400, 'invalid_request');

    const oversized = Array.from({ length: 9 }, (_, index) => ({
      op: 'put' as const,
      kind: 'message' as const,
      id: `msg_${index}`,
      value: 'y'.repeat(LIMITS.inlineBytes - 16),
    }));
    await expectError(
      await api.apply(id, batch(sourceID, 0, 1, oversized)),
      413,
      'request_too_large'
    );
    expect(await state(api, id)).toMatchObject({ position: 0, revision: 0 });
  });
});

describe('creator and tenant authority', () => {
  it('lets organization members read but not change another creator session', async () => {
    const organizationID = crypto.randomUUID();
    const { api, id, sourceID } = await setup(member(`usr-${crypto.randomUUID()}`, organizationID));
    await api.apply(
      id,
      batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'msg_1', value: 'mine' }])
    );
    const { hash } = await upload(api, id, 'creator bytes');

    const other = client(member(`usr-${crypto.randomUUID()}`, organizationID));
    expect((await state(other, id)).deleted).toBe(false);
    expect(await readAll(other, id)).toHaveLength(1);
    expect((await other.getBlob(id, hash)).status).toBe(200);

    await expectError(await other.register(id, sourceID), 403, 'creator_mismatch');
    await expectError(
      await other.apply(
        id,
        batch(sourceID, 1, 2, [{ op: 'put', kind: 'message', id: 'msg_1', value: 'theirs' }])
      ),
      403,
      'creator_mismatch'
    );
    const bytes = new TextEncoder().encode('other bytes');
    await expectError(await other.putBlob(id, await sha256(bytes), bytes), 403, 'creator_mismatch');
    await expectError(await other.remove(id), 403, 'creator_mismatch');
    expect(await readAll(api, id)).toEqual([
      { kind: 'message', id: 'msg_1', revision: 1, value: 'mine' },
    ]);
  });

  it('separates tenants that use the same session ID', async () => {
    const userID = `usr-${crypto.randomUUID()}`;
    const { api, id, sourceID } = await setup(personal(userID));
    await api.apply(
      id,
      batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'msg_1', value: 'private' }])
    );

    const stranger = client(personal(`usr-${crypto.randomUUID()}`));
    await expectError(await stranger.state(id), 404, 'session_not_found');
    await expectError(await stranger.entities(id), 404, 'session_not_found');

    const sameUserInOrganization = client(member(userID, crypto.randomUUID()));
    await expectError(await sameUserInOrganization.state(id), 404, 'session_not_found');
    expect((await sameUserInOrganization.register(id, crypto.randomUUID())).status).toBe(201);
    expect(await readAll(sameUserInOrganization, id)).toEqual([]);
    expect(await readAll(api, id)).toHaveLength(1);
  });

  it('validates the principal at the Durable Object boundary', async () => {
    const sessionID = newSessionID();
    const result = await getSessionSyncDOStub(testEnv, {
      tenant: { type: 'user', id: 'usr-a' },
      sessionID,
    }).register({
      principal: { userID: 'usr-b', tenant: { type: 'user', id: 'usr-a' } },
      sessionID,
      request: { version: 1, sourceID: crypto.randomUUID() },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_request');
  });
});

describe('blobs', () => {
  it('verifies, stores, and serves private session bytes', async () => {
    const { api, id, sourceID, principal } = await setup();
    const { bytes, hash, response } = await upload(api, id, 'attachment body');
    expect(response.status).toBe(201);
    expect(blobAckSchema.parse(await response.json())).toEqual({
      version: 1,
      hash,
      bytes: bytes.byteLength,
      created: true,
    });

    const again = await api.putBlob(id, hash, bytes);
    expect(again.status).toBe(200);
    expect(blobAckSchema.parse(await again.json()).created).toBe(false);

    const read = await api.getBlob(id, hash);
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);

    const applied = await api.apply(
      id,
      batch(sourceID, 0, 1, [
        { op: 'put', kind: 'asset', id: 'asset_1', blob: { hash, bytes: bytes.byteLength } },
      ])
    );
    expect(applied.status).toBe(200);
    expect(await readAll(api, id)).toEqual([
      { kind: 'asset', id: 'asset_1', revision: 1, blob: { hash, bytes: bytes.byteLength } },
    ]);
    expect(await state(api, id)).toMatchObject({ usage: { blobBytes: bytes.byteLength } });

    const listed = await testEnv.SESSION_SYNC_R2.list({ prefix: blobPrefix(principal, id) });
    expect(listed.objects).toHaveLength(1);
    expect(listed.objects[0]?.key.startsWith(`${blobPrefix(principal, id)}${hash}/`)).toBe(true);
  });

  it('consumes a duplicate upload before acknowledging the retry', async () => {
    const { api, id } = await setup();
    const bytes = new Uint8Array(70_000).fill(7);
    const hash = await sha256(bytes);
    expect((await api.putBlob(id, hash, bytes)).status).toBe(201);
    let offset = 0;
    let completed = false;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.byteLength) {
          completed = true;
          controller.close();
          return;
        }
        const end = Math.min(offset + 1024, bytes.byteLength);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
      cancel() {
        canceled = true;
      },
    });
    const response = await api.send('PUT', `/v1/sessions/${id}/blobs/${hash}`, {
      body,
      headers: { 'content-length': String(bytes.byteLength) },
    });
    expect(response.status).toBe(200);
    expect(completed).toBe(true);
    expect(canceled).toBe(false);
    expect(new Uint8Array(await (await api.getBlob(id, hash)).arrayBuffer())).toEqual(bytes);
  });

  it('refuses corrupt bytes without storing or acknowledging them', async () => {
    const { api, id, sourceID, principal } = await setup();
    const bytes = new TextEncoder().encode('tampered body');
    const claimed = await sha256(new TextEncoder().encode('original body'));

    await expectError(await api.putBlob(id, claimed, bytes), 400, 'blob_hash_mismatch');
    await expectError(await api.getBlob(id, claimed), 404, 'blob_not_found');
    await expectError(
      await api.apply(
        id,
        batch(sourceID, 0, 1, [
          { op: 'put', kind: 'asset', id: 'asset_1', blob: { hash: claimed, bytes: 13 } },
        ])
      ),
      409,
      'blob_missing'
    );
    const listed = await testEnv.SESSION_SYNC_R2.list({ prefix: blobPrefix(principal, id) });
    expect(listed.objects).toEqual([]);
    // A failed upload keeps its reservation until the cleanup deadline. This
    // retains a durable cleanup record even when the request disconnects.
    expect(await state(api, id)).toMatchObject({ usage: { blobBytes: bytes.byteLength } });
    const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID: id });
    await expireUploads(stub, claimed);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await state(api, id)).toMatchObject({ usage: { blobBytes: 0 } });
  });

  it('requires a declared length and bounds blob size', async () => {
    const { api, id } = await setup();
    const hash = await sha256(new Uint8Array(0));
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    await expectError(
      await api.send('PUT', `/v1/sessions/${id}/blobs/${hash}`, {
        body: streamed,
        duplex: 'half',
      } as RequestInit),
      411,
      'length_required'
    );

    const large = new Uint8Array(LIMITS.blobBytes + 1);
    await expectError(await api.putBlob(id, hash, large), 413, 'request_too_large');
  });
});

describe('deletion', () => {
  it('tombstones the session, purges its bytes, and refuses recreation', async () => {
    const { api, id, sourceID, principal } = await setup();
    await api.apply(
      id,
      batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'msg_1', value: 'secret' }])
    );
    const { hash, bytes } = await upload(api, id, 'secret attachment');

    const deleted = await api.remove(id);
    expect(deleted.status).toBe(200);
    expect(sessionStateSchema.parse(await deleted.json())).toMatchObject({ deleted: true });
    expect((await api.remove(id)).status).toBe(200);

    expect(await state(api, id)).toMatchObject({ sessionID: id, deleted: true });
    await expectError(await api.register(id, sourceID), 410, 'session_deleted');
    await expectError(await api.register(id, crypto.randomUUID()), 410, 'session_deleted');
    await expectError(await api.apply(id, batch(sourceID, 1, 2, [])), 410, 'session_deleted');
    await expectError(await api.entities(id), 410, 'session_deleted');
    await expectError(await api.getBlob(id, hash), 410, 'session_deleted');
    await expectError(await api.putBlob(id, hash, bytes), 410, 'session_deleted');

    const listed = await testEnv.SESSION_SYNC_R2.list({ prefix: blobPrefix(principal, id) });
    expect(listed.objects).toEqual([]);
  });

  it('removes an upload that finishes after deletion', async () => {
    const { api, id, principal } = await setup();
    const bytes = new TextEncoder().encode('late upload');
    const hash = await sha256(bytes);
    const stub = () => getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID: id });
    const input = { principal, sessionID: id, blob: { hash, bytes: bytes.byteLength } };

    const begun = await stub().beginBlob(input);
    if (!begun.ok || begun.value.status !== 'upload') throw new Error('expected an upload');
    expect((await api.remove(id)).status).toBe(200);
    // The object lands after deletion, while its pending deadline remains.
    await testEnv.SESSION_SYNC_R2.put(begun.value.key, bytes, { sha256: hash });

    const committed = await stub().commitBlob({ ...input, attempt: begun.value.attempt });
    expect(committed.ok).toBe(false);
    if (!committed.ok) expect(committed.error.code).toBe('session_deleted');
    expect(await testEnv.SESSION_SYNC_R2.head(begun.value.key)).toBeNull();
  });

  it('purges objects of uploads that never commit after deletion', async () => {
    const { api, id, principal } = await setup();
    const bytes = new TextEncoder().encode('abandoned upload');
    const hash = await sha256(bytes);
    const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID: id });
    const begun = await stub.beginBlob({
      principal,
      sessionID: id,
      blob: { hash, bytes: bytes.byteLength },
    });
    if (!begun.ok || begun.value.status !== 'upload') throw new Error('expected an upload');
    expect((await api.remove(id)).status).toBe(200);
    await testEnv.SESSION_SYNC_R2.put(begun.value.key, bytes, { sha256: hash });

    await expireUploads(stub, hash);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await testEnv.SESSION_SYNC_R2.head(begun.value.key)).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });
});

describe('abandoned uploads', () => {
  it('deletes the object and releases the reservation after the deadline', async () => {
    const { api, id, principal } = await setup();
    const bytes = new TextEncoder().encode('crashed before commit');
    const hash = await sha256(bytes);
    const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID: id });
    const input = { principal, sessionID: id, blob: { hash, bytes: bytes.byteLength } };
    const begun = await stub.beginBlob(input);
    if (!begun.ok || begun.value.status !== 'upload') throw new Error('expected an upload');
    await testEnv.SESSION_SYNC_R2.put(begun.value.key, bytes, { sha256: hash });
    expect(await state(api, id)).toMatchObject({ usage: { blobBytes: bytes.byteLength } });

    await expireUploads(stub, hash);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await testEnv.SESSION_SYNC_R2.head(begun.value.key)).toBeNull();
    expect(await state(api, id)).toMatchObject({ usage: { blobBytes: 0 } });

    const late = await stub.commitBlob({ ...input, attempt: begun.value.attempt });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe('blob_missing');
  });
});

/** Makes a pending upload eligible for cleanup without waiting for its deadline. */
async function expireUploads(stub: DurableObjectStub<SessionSyncDO>, hash: string) {
  await runInDurableObject(stub, (_instance, state) => {
    drizzle(state.storage)
      .update(blobs)
      .set({ deadline: Date.now() - 120_000 })
      .where(eq(blobs.hash, hash))
      .run();
  });
}

describe('entity pages', () => {
  it('pages by key and refuses a page from a changed revision', async () => {
    const { api, id, sourceID } = await setup();
    await api.apply(
      id,
      batch(sourceID, 0, 1, [
        { op: 'put', kind: 'message', id: 'msg_1', value: 1 },
        { op: 'put', kind: 'message', id: 'msg_2', value: 2 },
        { op: 'put', kind: 'message', id: 'msg_3', value: 3 },
      ])
    );

    const firstResponse = await api.entities(id, { limit: '2' });
    const first = pageSchema.parse(await firstResponse.json());
    expect(first.entities.map(entity => entity.id)).toEqual(['msg_1', 'msg_2']);
    expect(first.next).not.toBeNull();
    const cursor = first.next ?? '';

    const coherent = pageSchema.parse(
      await (await api.entities(id, { cursor, revision: String(first.revision) })).json()
    );
    expect(coherent.entities.map(entity => entity.id)).toEqual(['msg_3']);
    expect(coherent.next).toBeNull();

    await api.apply(
      id,
      batch(sourceID, 1, 2, [{ op: 'put', kind: 'message', id: 'msg_0', value: 0 }])
    );
    const stale = await api.entities(id, { cursor, revision: String(first.revision) });
    expect(stale.status).toBe(409);
    expect(errorBodySchema.parse(await stale.json()).error).toMatchObject({
      code: 'revision_changed',
      revision: first.revision + 1,
    });

    await expectError(await api.entities(id, { cursor: 'not-a-cursor' }), 400, 'invalid_request');
  });
});

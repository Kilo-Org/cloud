import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';
import { ingestItems, ingestMeta } from '../../src/db/sqlite-schema';

function identity() {
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const kiloUserId = `oauth/github:${suffix}`;
  const sessionId = `ses_${suffix.slice(0, 26)}`;
  return {
    kiloUserId,
    sessionId,
    stub: env.SESSION_INGEST_DO.getByName(`${kiloUserId}/${sessionId}`),
  };
}

describe('worktree session cleanup in Workers', () => {
  it('reads and deletes a never-run child snapshot without waking its expired runtime', async () => {
    const { kiloUserId, sessionId, stub } = identity();
    const info = {
      id: sessionId,
      parentID: 'ses_00000000000000000000000001',
      directory: '/workspace/owner/worktrees/worktree_11111111-1111-4111-8111-111111111111',
      title: 'Never-run engine child',
      slug: 'never-run',
      projectID: 'test-project',
      version: '7.4.20',
      time: { created: 1, updated: 1 },
    };
    const key = `items/${kiloUserId}/${sessionId}/session/1`;
    await env.SESSION_INGEST_R2.put(key, JSON.stringify(info));
    await stub.ingest([{ type: 'session', data: info }], kiloUserId, sessionId, 2, 1, {
      session: key,
    });
    await expect(stub.readKiloSdkSessionSnapshot()).resolves.toMatchObject({ kind: 'value', info });
    await stub.clearForWorktree(kiloUserId, sessionId);
    await expect(stub.readKiloSdkSessionSnapshot()).resolves.toEqual({ kind: 'pending' });
    expect(await env.SESSION_INGEST_R2.head(key)).toBeNull();
    await expect(
      stub.ingest([{ type: 'session', data: info }], kiloUserId, sessionId, 2)
    ).resolves.toMatchObject({ accepted: false, reason: 'deleted' });
    await stub.clearForWorktree(kiloUserId, sessionId);
  });

  it('fences late ingest before awaiting R2 and keeps failed inventory for an idempotent retry', async () => {
    const { kiloUserId, sessionId, stub } = identity();
    const key = `items/${kiloUserId}/${sessionId}/session/1`;
    await env.SESSION_INGEST_R2.put(key, JSON.stringify({ title: 'private transcript' }));
    await stub.ingest(
      [{ type: 'session', data: { title: 'private transcript' } }],
      kiloUserId,
      sessionId,
      1,
      1,
      { session: key }
    );
    await runInDurableObject(stub, async (instance, state) => {
      const original = instance['env'].SESSION_INGEST_R2;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let first = true;
      Object.assign(instance['env'], {
        SESSION_INGEST_R2: {
          list: (options?: R2ListOptions) => original.list(options),
          delete: async (keys: string | string[]) => {
            if (first) {
              first = false;
              entered.resolve();
              await release.promise;
              throw new Error('R2 unavailable');
            }
            await original.delete(keys);
          },
        },
      });
      try {
        await state.storage.setAlarm(Date.now() + 60_000);
        const cleanup = instance.clearForWorktree(kiloUserId, sessionId).then(
          () => undefined,
          error => error
        );
        await entered.promise;
        await expect(
          instance.ingest(
            [{ type: 'session', data: { title: 'late private data' } }],
            kiloUserId,
            sessionId,
            1
          )
        ).resolves.toEqual({ accepted: false, reason: 'deleted', changes: [] });
        release.resolve();
        expect(await cleanup).toBeInstanceOf(Error);
        expect(drizzle(state.storage).select().from(ingestItems).all()).toHaveLength(1);
        expect(await state.storage.getAlarm()).toBeNull();
      } finally {
        Object.assign(instance['env'], { SESSION_INGEST_R2: original });
      }
    });
    expect(await env.SESSION_INGEST_R2.head(key)).not.toBeNull();
    await stub.clearForWorktree(kiloUserId, sessionId);
    expect(await env.SESSION_INGEST_R2.head(key)).toBeNull();
    await runInDurableObject(stub, async (instance, state) => {
      expect(drizzle(state.storage).select().from(ingestItems).all()).toEqual([]);
      expect(drizzle(state.storage).select().from(ingestMeta).all()).toEqual([
        { key: 'deleted', value: 'true' },
      ]);
      await expect(instance.resetCloneStage()).rejects.toThrow('Session deleted');
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('waits for an in-flight upload, removes staged and offloaded bodies, and rejects future uploads', async () => {
    const { kiloUserId, sessionId, stub } = identity();
    const key = `ingest/${kiloUserId}/${sessionId}/pending`;
    const otherKey = `items/${kiloUserId}/ses_other/session/1`;
    await env.SESSION_INGEST_R2.put(otherKey, 'preserved');
    await runInDurableObject(stub, async (instance, state) => {
      const original = instance['env'].SESSION_INGEST_R2;
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      Object.assign(instance['env'], {
        SESSION_INGEST_R2: {
          put: async (name: string, body: ReadableStream<Uint8Array>) => {
            started.resolve();
            await release.promise;
            return original.put(name, body);
          },
          list: (options?: R2ListOptions) => original.list(options),
          delete: (keys: string | string[]) => original.delete(keys),
        },
      });
      try {
        const upload = instance.stageR2Object(
          { kiloUserId, sessionId, key },
          new Blob(['private staging body']).stream()
        );
        await started.promise;
        let finished = false;
        const cleanup = instance.clearForWorktree(kiloUserId, sessionId).then(() => {
          finished = true;
        });
        await Promise.resolve();
        expect(finished).toBe(false);
        release.resolve();
        await expect(upload).resolves.toBe(false);
        await cleanup;
        expect(await original.head(key)).toBeNull();
        await expect(
          instance.stageR2Object({ kiloUserId, sessionId, key }, new Blob(['late body']).stream())
        ).resolves.toBe(false);
        expect(await original.head(key)).toBeNull();
        expect(drizzle(state.storage).select().from(ingestMeta).all()).toEqual([
          { key: 'deleted', value: 'true' },
        ]);
      } finally {
        Object.assign(instance['env'], { SESSION_INGEST_R2: original });
      }
    });
    expect(await env.SESSION_INGEST_R2.head(otherKey)).not.toBeNull();
    await env.SESSION_INGEST_R2.delete(otherKey);
  });

  it('prevents a late payload commit after an interrupted handler loses its in-memory upload inventory', async () => {
    const { kiloUserId, sessionId, stub } = identity();
    const key = `ingest/${kiloUserId}/${sessionId}/interrupted`;
    await runInDurableObject(stub, async (instance, state) => {
      const original = instance['env'].SESSION_INGEST_R2;
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const committed = Promise.withResolvers<R2Object | null>();
      const resume = Promise.withResolvers<void>();
      Object.assign(instance['env'], {
        SESSION_INGEST_R2: {
          head: (name: string) => original.head(name),
          list: (options?: R2ListOptions) => original.list(options),
          delete: (keys: string | string[]) => original.delete(keys),
          put: async (
            name: string,
            value: Parameters<R2Bucket['put']>[1],
            options?: R2PutOptions
          ) => {
            if (typeof value === 'string') return original.put(name, value, options);
            started.resolve();
            await release.promise;
            const written = await original.put(name, value, options);
            committed.resolve(written);
            await resume.promise;
            return written;
          },
        },
      });
      const upload = instance.stageR2Object(
        { kiloUserId, sessionId, key },
        new Blob(['private interrupted payload']).stream()
      );
      try {
        await started.promise;
        Object.assign(instance, { activeR2Writes: new Set<Promise<unknown>>() });
        await instance.clearForWorktree(kiloUserId, sessionId);
        release.resolve();
        expect(await committed.promise).toBeNull();
        expect(await original.head(key)).toBeNull();
        expect(drizzle(state.storage).select().from(ingestMeta).all()).toEqual([
          { key: 'deleted', value: 'true' },
        ]);
        resume.resolve();
        await expect(upload).resolves.toBe(false);
      } finally {
        release.resolve();
        resume.resolve();
        await upload.catch(() => undefined);
        Object.assign(instance['env'], { SESSION_INGEST_R2: original });
      }
    });
  });

  it('can replace an existing body without exposing the reservation as session data', async () => {
    const { kiloUserId, sessionId, stub } = identity();
    const key = `items/${kiloUserId}/${sessionId}/message/1`;
    await stub.stageR2Object({ kiloUserId, sessionId, key }, new Blob(['first']).stream());
    await stub.stageR2Object({ kiloUserId, sessionId, key }, new Blob(['second']).stream());
    expect(await (await env.SESSION_INGEST_R2.get(key))?.text()).toBe('second');
    await stub.clearForWorktree(kiloUserId, sessionId);
  });

  it('accepts large R2 bodies over streaming RPC and deletes the complete per-session prefixes', async () => {
    const { kiloUserId, sessionId, stub } = identity();
    const key = `items/${kiloUserId}/${sessionId}/large/1`;
    const rawKey = `ingest/${kiloUserId}/${sessionId}/queued`;
    const body = 'x'.repeat(2 * 1024 * 1024);
    await expect(
      stub.stageR2Object({ kiloUserId, sessionId, key }, new Blob([body]).stream())
    ).resolves.toBe(true);
    await env.SESSION_INGEST_R2.put(rawKey, 'pending queue payload');
    expect((await env.SESSION_INGEST_R2.head(key))?.size).toBe(body.length);
    await stub.clearForWorktree(kiloUserId, sessionId);
    expect(await env.SESSION_INGEST_R2.head(key)).toBeNull();
    expect(await env.SESSION_INGEST_R2.head(rawKey)).toBeNull();
    await expect(stub.isDeleted()).resolves.toBe(true);
  });

  it('does not let late public bootstrap overwrite an adopted child scope, including after invalidation', async () => {
    const owner = `oauth/cache-scope:${crypto.randomUUID()}`;
    const cache = env.SESSION_ACCESS_CACHE_DO.getByName(owner);
    const sessionId = 'ses_00000000000000000000000001';
    const scoped = {
      sessionId,
      organizationId: '11111111-1111-4111-8111-111111111111',
      cloudAgentSessionScopeId: 'workspace_11111111-1111-4111-8111-111111111111',
    };
    const unscoped = { sessionId, organizationId: null, cloudAgentSessionScopeId: null };
    await cache.putValidated(unscoped);
    await cache.putValidated(scoped);
    await cache.putValidated(unscoped);
    await expect(cache.getAccess(sessionId)).resolves.toEqual(scoped);
    await cache.invalidateOrganization(scoped.organizationId);
    await cache.putValidated(unscoped);
    await expect(cache.getAccess(sessionId)).resolves.toBeNull();
    await cache.putValidated(scoped);
    await cache.putValidated({ ...scoped, cloudAgentSessionScopeId: 'another-root' });
    await expect(cache.getAccess(sessionId)).resolves.toEqual(scoped);
    await cache.deleteSession(sessionId);
    await cache.putValidated(scoped);
    await expect(cache.getAccess(sessionId)).resolves.toBeNull();
  });

  it('removes only targeted cache entries and fences stale authorization cache writes', async () => {
    const owner = `oauth/cache:${crypto.randomUUID()}`;
    const cache = env.SESSION_ACCESS_CACHE_DO.getByName(owner);
    const target = 'ses_00000000000000000000000001';
    const other = 'ses_00000000000000000000000002';
    const access = { sessionId: target, organizationId: null, cloudAgentSessionScopeId: null };
    await cache.putValidated(access);
    await cache.putValidated({ ...access, sessionId: other });
    await cache.deleteSession(target);
    await cache.putValidated(access);
    expect(await cache.getAccess(target)).toBeNull();
    expect(await cache.getAccess(other)).toMatchObject({ sessionId: other });
  });

  it('keeps shared user connections alive while removing only targeted subscriptions, renames, and command data', async () => {
    const owner = `oauth/connection:${crypto.randomUUID()}`;
    const connection = env.USER_CONNECTION_DO.getByName(owner);
    const target = 'ses_00000000000000000000000001';
    const other = 'ses_00000000000000000000000002';
    await runInDurableObject(connection, async (instance, state) => {
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[1], ['web']);
      pair[0].accept();
      pair[1].serializeAttachment({
        role: 'web',
        connectionId: 'viewer',
        kiloUserId: owner,
        subscribedSessions: [target, other],
      });
      await state.storage.put({
        [`rename:${target}`]: { title: 'private name', at: Date.now() },
        [`rename:${other}`]: { title: 'preserved name', at: Date.now() },
        [`readyPush:${target}`]: {
          title: 'private title',
          kiloUserId: owner,
          fireAt: Date.now() + 60_000,
          attempts: 0,
        },
        'pendingCommand/target': { sessionId: target, state: 'done', result: 'private transcript' },
        'pendingCommand/other': {
          sessionId: other,
          state: 'done',
          result: 'preserved',
          expiresAt: Date.now() + 3_600_000,
        },
      });
      await instance.clearSession(target);
      expect(await state.storage.get(`rename:${target}`)).toBeUndefined();
      expect(await state.storage.get(`readyPush:${target}`)).toBeUndefined();
      expect(await state.storage.get('pendingCommand/target')).toBeUndefined();
      expect(await state.storage.get(`rename:${other}`)).toMatchObject({ title: 'preserved name' });
      expect(await state.storage.get('pendingCommand/other')).toMatchObject({
        result: 'preserved',
      });
      expect(pair[1].deserializeAttachment()).toMatchObject({ subscribedSessions: [other] });
      expect(pair[0].readyState).toBe(WebSocket.OPEN);
      await expect(instance.notifySessionRenamed(target, 'late private name')).resolves.toEqual({
        delivered: false,
      });
      expect(await state.storage.get(`rename:${target}`)).toBeUndefined();
      pair[0].close();
    });
  });
});

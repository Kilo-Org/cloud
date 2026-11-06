import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it, vi } from 'vitest';

import {
  relayCommands,
  relayRates,
  relayState,
  relayWatches,
} from '../../src/db/relay-sqlite-schema';
import { session } from '../../src/db/sqlite-schema';
import { createdSessions } from '../../src/db/tenant-sqlite-schema';
import { getRelayStub } from '../../src/dos/SessionRelayDO';
import { getSessionSyncDOStub, RETENTION_MS } from '../../src/dos/SessionSyncDO';
import { getTenantStub } from '../../src/dos/SessionSyncTenantDO';
import type { Env } from '../../src/env';
import { LIVE_LIMITS } from '../../src/live/protocol';
import { mintTicket, verifyTicket } from '../../src/live/ticket';
import { blobPrefix, client, grant, newSessionID, personal, sha256, testEnv } from '../helpers';

async function setup() {
  const principal = personal(`live-delete-${crypto.randomUUID()}`);
  const sessionID = newSessionID();
  const sync = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  expect(
    await sync.register({
      principal,
      sessionID,
      request: { version: 1, sourceID: crypto.randomUUID() },
    })
  ).toMatchObject({ ok: true });
  expect(await sync.authorizeLive({ principal, sessionID })).toEqual({
    ok: true,
    value: { role: 'owner' },
  });
  const ticket = (
    await mintTicket(
      new Request('https://session-sync.test/ticket', {
        headers: { authorization: `Bearer ${await grant(principal)}` },
      }),
      testEnv,
      principal,
      'session-relay',
      'controller',
      sessionID
    )
  ).ticket;
  const relay = getRelayStub(testEnv, principal.tenant, sessionID);
  const command = {
    channel: 'commands',
    type: 'send_message',
    commandID: crypto.randomUUID(),
    body: { prompt: 'private queued content must be erased' },
    ttlMs: LIVE_LIMITS.mailboxMaxMs,
  };
  expect(await (await relay.command({ ticket, command })).json()).toMatchObject({
    status: 'queued',
  });
  await runInDurableObject(relay, (_instance, state) => {
    const row = drizzle(state.storage).select().from(relayCommands).get();
    expect(row?.payload).toContain('private queued content');
    expect((row?.expires_at ?? 0) - (row?.created_at ?? 0)).toBe(LIVE_LIMITS.mailboxMaxMs);
  });
  return { principal, sessionID, sync, relay, ticket, command };
}

describe('session deletion purges the live relay', () => {
  it.each(['delete', 'account erasure', 'retention'] as const)(
    'never touches the relay binding for a sync-only session on %s',
    async entry => {
      const principal = personal(`sync-only-${crypto.randomUUID()}`);
      const sessionID = newSessionID();
      const sync = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
      expect(
        await sync.register({
          principal,
          sessionID,
          request: { version: 1, sourceID: crypto.randomUUID() },
        })
      ).toMatchObject({ ok: true });
      await runInDurableObject(sync, async (instance, state) => {
        const exposed = instance as unknown as { env: Env };
        const original = exposed.env;
        const touched = vi.fn(() => {
          throw new Error('Sync-only deletion must not touch relay');
        });
        exposed.env = {
          ...original,
          SESSION_RELAY_DO: {
            idFromName: touched,
            get: touched,
          } as unknown as Env['SESSION_RELAY_DO'],
        };
        try {
          if (entry === 'retention') {
            const meta = drizzle(state.storage).select().from(session).get();
            if (!meta) throw new Error('Expected registered session');
            const clock = vi.spyOn(Date, 'now').mockReturnValue(meta.last_write_at + RETENTION_MS);
            try {
              await instance.alarm();
            } finally {
              clock.mockRestore();
            }
          } else {
            const result =
              entry === 'delete'
                ? await instance.deleteSession({ principal, sessionID })
                : await instance.eraseForUser({ principal, sessionID });
            expect(result).toMatchObject({ ok: true });
          }
          await instance.alarm();
          expect(touched).not.toHaveBeenCalled();
          expect(await state.storage.get('relayUsed')).toBeUndefined();
          expect(await state.storage.get('relayPurged')).toBeUndefined();
          expect(drizzle(state.storage).select().from(session).get()?.deleted_at).not.toBeNull();
        } finally {
          exposed.env = original;
        }
      });
    }
  );

  it('persists live activation before returning authorization and retains it after restart', async () => {
    const { principal, sessionID, sync, relay } = await setup();
    await runInDurableObject(sync, async (_instance, state) => {
      expect(await state.storage.get('relayUsed')).toBe(true);
    });
    await expect(
      runInDurableObject(sync, (_instance, state) =>
        state.abort('Synthetic live activation restart')
      )
    ).rejects.toThrow();
    const restartedSync = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
    expect(await restartedSync.deleteSession({ principal, sessionID })).toMatchObject({ ok: true });
    await runInDurableObject(restartedSync, async (_instance, state) => {
      expect(await state.storage.get('relayUsed')).toBe(true);
      expect(await state.storage.get('relayPurged')).toBe(true);
    });
    await runInDurableObject(relay, (_instance, state) => {
      expect(drizzle(state.storage).select().from(relayCommands).all()).toEqual([]);
      expect(drizzle(state.storage).select().from(relayState).get()?.purged).toBe(true);
    });
  });

  it.each(['authorize first', 'delete first'] as const)(
    'serializes live activation against deletion: %s',
    async order => {
      const principal = personal(`live-race-${crypto.randomUUID()}`);
      const sessionID = newSessionID();
      const sync = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
      expect(
        await sync.register({
          principal,
          sessionID,
          request: { version: 1, sourceID: crypto.randomUUID() },
        })
      ).toMatchObject({ ok: true });
      await runInDurableObject(sync, async (instance, state) => {
        const input = { principal, sessionID };
        if (order === 'authorize first') {
          const authorization = instance.authorizeLive(input);
          const deletion = instance.deleteSession(input);
          expect(await authorization).toEqual({ ok: true, value: { role: 'owner' } });
          expect(await deletion).toMatchObject({ ok: true });
          expect(await state.storage.get('relayUsed')).toBe(true);
          expect(await state.storage.get('relayPurged')).toBe(true);
        } else {
          const deletion = instance.deleteSession(input);
          const authorization = instance.authorizeLive(input);
          expect(await deletion).toMatchObject({ ok: true });
          expect(await authorization).toMatchObject({
            ok: false,
            error: { code: 'session_deleted' },
          });
          expect(await state.storage.get('relayUsed')).toBeUndefined();
          expect(await state.storage.get('relayPurged')).toBeUndefined();
        }
      });
    }
  );

  it.each(['delete', 'account erasure', 'retention'] as const)(
    'purges queued payloads on %s and fences still-valid old tickets',
    async entry => {
      const fixture = await setup();
      const { principal, sessionID, sync, relay, ticket, command } = fixture;
      if (entry === 'delete') {
        expect(await sync.deleteSession({ principal, sessionID })).toMatchObject({ ok: true });
      } else if (entry === 'account erasure') {
        expect(await sync.eraseForUser({ principal, sessionID })).toEqual({
          ok: true,
          value: null,
        });
      } else {
        await runInDurableObject(sync, async (instance, state) => {
          const meta = drizzle(state.storage).select().from(session).get();
          if (!meta) throw new Error('Expected registered session');
          const clock = vi.spyOn(Date, 'now').mockReturnValue(meta.last_write_at + RETENTION_MS);
          try {
            await instance.alarm();
          } finally {
            clock.mockRestore();
          }
        });
      }
      await runInDurableObject(sync, async (_instance, state) => {
        expect(await state.storage.get('relayPurged')).toBe(true);
        expect(await state.storage.get('relayPurgeRetryAt')).toBe(0);
        expect(drizzle(state.storage).select().from(session).get()?.deleted_at).not.toBeNull();
      });
      await runInDurableObject(relay, (_instance, state) => {
        const db = drizzle(state.storage);
        expect(db.select().from(relayCommands).all()).toEqual([]);
        expect(db.select().from(relayRates).all()).toEqual([]);
        expect(db.select().from(relayWatches).all()).toEqual([]);
        expect(db.select().from(relayState).get()?.purged).toBe(true);
      });
      // Rejecting the old token is a permanent relay tombstone, not merely ticket expiration.
      expect(await verifyTicket(ticket, testEnv, 'session-relay')).toBeDefined();
      expect(
        (await relay.command({ ticket, command: { ...command, commandID: crypto.randomUUID() } }))
          .status
      ).toBe(403);
      expect(
        (
          await relay.fetch(
            new Request('https://relay.test/', {
              headers: { upgrade: 'websocket', authorization: `Bearer ${ticket}` },
            })
          )
        ).status
      ).toBe(401);
      await expect(
        runInDurableObject(relay, (_instance, state) =>
          state.abort('Synthetic purged relay restart')
        )
      ).rejects.toThrow();
      const restartedRelay = getRelayStub(testEnv, principal.tenant, sessionID);
      expect(
        (
          await restartedRelay.command({
            ticket,
            command: { ...command, commandID: crypto.randomUUID() },
          })
        ).status
      ).toBe(403);
      expect(
        (
          await restartedRelay.fetch(
            new Request('https://relay.test/', {
              headers: { upgrade: 'websocket', authorization: `Bearer ${ticket}` },
            })
          )
        ).status
      ).toBe(401);
      expect(await sync.authorizeLive({ principal, sessionID })).toMatchObject({
        ok: false,
        error: { code: 'session_deleted' },
      });
    }
  );

  it.each([
    { entry: 'delete', failure: 'before purge' },
    { entry: 'delete', failure: 'after purge response is lost' },
    { entry: 'account erasure', failure: 'before purge' },
    { entry: 'account erasure', failure: 'after purge response is lost' },
  ] as const)(
    '$entry durably retries $failure without acknowledging completion',
    async ({ entry, failure }) => {
      const { principal, sessionID, sync, relay, ticket, command } = await setup();
      const bytes = new TextEncoder().encode('private durable blob');
      const hash = await sha256(bytes);
      expect((await client(principal).putBlob(sessionID, hash, bytes)).status).toBe(201);
      const retryAt = await runInDurableObject(sync, async (instance, state) => {
        const exposed = instance as unknown as { env: Env };
        const original = exposed.env;
        const namespace = original.SESSION_RELAY_DO;
        exposed.env = {
          ...original,
          SESSION_RELAY_DO: {
            idFromName: namespace.idFromName.bind(namespace),
            get: (id: DurableObjectId) => ({
              purge: async () => {
                if (failure === 'after purge response is lost') await namespace.get(id).purge();
                throw new Error('Synthetic relay purge failure');
              },
            }),
          } as unknown as Env['SESSION_RELAY_DO'],
        };
        try {
          const result =
            entry === 'delete'
              ? await instance.deleteSession({ principal, sessionID })
              : await instance.eraseForUser({ principal, sessionID });
          expect(result).toMatchObject({ ok: false, error: { code: 'tenant_unavailable' } });
        } finally {
          exposed.env = original;
        }
        expect(drizzle(state.storage).select().from(session).get()?.deleted_at).not.toBeNull();
        expect(await state.storage.get('relayPurged')).not.toBe(true);
        expect(await state.storage.getAlarm()).not.toBeNull();
        const retryAt = await state.storage.get<number>('relayPurgeRetryAt');
        if (retryAt === undefined) throw new Error('Expected durable relay retry deadline');
        return retryAt;
      });
      // A relay outage does not stop the independent durable blob cleanup.
      expect(
        (await testEnv.SESSION_SYNC_R2.list({ prefix: blobPrefix(principal, sessionID) })).objects
      ).toEqual([]);
      await runInDurableObject(getTenantStub(testEnv, principal.tenant), (_instance, state) => {
        expect(drizzle(state.storage).select().from(createdSessions).all()).toHaveLength(1);
      });
      await runInDurableObject(relay, (_instance, state) => {
        expect(drizzle(state.storage).select().from(relayCommands).all()).toHaveLength(
          failure === 'before purge' ? 1 : 0
        );
      });
      await expect(
        runInDurableObject(sync, (_instance, state) =>
          state.abort('Synthetic sync purge retry restart')
        )
      ).rejects.toThrow();
      const restartedSync = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
      await runInDurableObject(restartedSync, async (instance, state) => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(retryAt + 1);
        try {
          await instance.alarm();
        } finally {
          clock.mockRestore();
        }
        expect(await state.storage.get('relayPurged')).toBe(true);
        expect(await state.storage.get('relayPurgeRetryAt')).toBe(0);
      });
      await runInDurableObject(relay, (_instance, state) => {
        expect(drizzle(state.storage).select().from(relayCommands).all()).toEqual([]);
        expect(drizzle(state.storage).select().from(relayState).get()?.purged).toBe(true);
      });
      await runInDurableObject(getTenantStub(testEnv, principal.tenant), (_instance, state) => {
        expect(drizzle(state.storage).select().from(createdSessions).all()).toEqual([]);
      });
      expect(
        (await relay.command({ ticket, command: { ...command, commandID: crypto.randomUUID() } }))
          .status
      ).toBe(403);
      expect(await restartedSync.deleteSession({ principal, sessionID })).toMatchObject({
        ok: true,
      });
    }
  );
});

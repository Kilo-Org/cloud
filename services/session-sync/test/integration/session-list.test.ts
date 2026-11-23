import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { bytesToBase64url } from '@kilocode/worker-utils/base64url';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import { listMetadata } from '../../src/db/sqlite-schema';
import { getSessionSyncDOStub, type SessionSyncDO } from '../../src/dos/SessionSyncDO';
import { getTenantStub } from '../../src/dos/SessionSyncTenantDO';
import type { Env } from '../../src/env';
import { batch, client, member, newSessionID, personal, testEnv, type Client } from '../helpers';

/** Makes the next `updateCreatedSession` call fail without reaching the tenant. */
async function loseNextIndexPush(stub: DurableObjectStub<SessionSyncDO>, userID: string) {
  await runInDurableObject(stub, instance => {
    const exposed = instance as unknown as { env: Env };
    const namespace = exposed.env.SESSION_SYNC_TENANT_DO;
    const realTenant = getTenantStub(testEnv, { type: 'user', id: userID });
    let lost = false;
    exposed.env = {
      ...exposed.env,
      SESSION_SYNC_TENANT_DO: {
        idFromName: namespace.idFromName.bind(namespace),
        get: () => ({
          reserve: (input: unknown) => realTenant.reserve(input),
          release: (input: unknown) => realTenant.release(input),
          trackCreatedSession: (input: unknown) => realTenant.trackCreatedSession(input),
          forgetCreatedSession: (input: unknown) => realTenant.forgetCreatedSession(input),
          listCreatedSessions: (input: unknown) => realTenant.listCreatedSessions(input),
          eraseUser: (input: unknown) => realTenant.eraseUser(input),
          updateCreatedSession: async (input: unknown) => {
            if (!lost) {
              lost = true;
              throw new Error('Synthetic refused tenant call');
            }
            return await realTenant.updateCreatedSession(input);
          },
        }),
      } as unknown as Env['SESSION_SYNC_TENANT_DO'],
    };
  });
}

type Item = {
  sessionID: string;
  tenant: { type: string; id: string };
  createdAt: number;
  updatedAt: number;
  title: string | null;
  client: string;
  directory: string | null;
  archived: boolean;
  live: boolean;
};

async function listing(api: Client, query = '') {
  const response = await api.send('GET', `/v1/sessions${query}`);
  expect(response.status).toBe(200);
  return response.json<{ version: 1; items: Item[]; cursor: string | null }>();
}

/** Registers a session and commits the session entity its list metadata comes from. */
async function seed(
  api: Client,
  options: {
    client?: 'cli' | 'mobile' | 'cloud-agent';
    title: string;
    directory: string;
    updated: number;
    archived?: boolean;
  }
): Promise<string> {
  const id = newSessionID();
  const sourceID = crypto.randomUUID();
  expect((await api.register(id, sourceID, options.client)).status).toBe(201);
  const time = {
    created: options.updated - 10,
    updated: options.updated,
    ...(options.archived ? { archived: options.updated } : {}),
  };
  const applied = await api.apply(
    id,
    batch(sourceID, 0, 1, [
      {
        op: 'put',
        kind: 'session',
        id,
        value: {
          id,
          title: options.title,
          origin: { directory: options.directory, client: options.client ?? 'cli' },
          time,
        },
      },
    ])
  );
  expect(applied.status).toBe(200);
  return id;
}

describe('creator session list', () => {
  it('pages only my sessions newest first across personal and organization tenants', async () => {
    const userID = `usr-${crypto.randomUUID()}`;
    const mine = client(personal(userID));
    const org = crypto.randomUUID();
    const organization = client(member(userID, org));
    const stranger = client(member(`usr-${crypto.randomUUID()}`, org));
    const ids = [newSessionID(), newSessionID(), newSessionID()];
    for (const [index, api] of [mine, organization, stranger].entries()) {
      expect((await api.register(ids[index], crypto.randomUUID())).status).toBe(201);
    }
    const all = await listing(mine);
    expect(new Set(all.items.map(item => item.sessionID))).toEqual(new Set(ids.slice(0, 2)));
    expect(all.items[0].updatedAt).toBeGreaterThanOrEqual(all.items[1].updatedAt);
    expect(all.items.find(item => item.sessionID === ids[1])).toMatchObject({
      tenant: { type: 'organization', id: org },
      live: false,
      title: null,
      client: 'cli',
      directory: null,
      archived: false,
    });
    const first = await listing(mine, '?limit=1');
    expect(first.items).toHaveLength(1);
    expect(first.items).toEqual(all.items.slice(0, 1));
    expect(first.cursor).toBeTypeOf('string');
    const second = await listing(mine, `?limit=1&cursor=${encodeURIComponent(first.cursor ?? '')}`);
    expect(second.items).toEqual(all.items.slice(1));
    expect(second.cursor).toBeNull();
    expect((await listing(stranger)).items.map(item => item.sessionID)).toEqual([ids[2]]);
    expect((await listing(organization)).items).toEqual(all.items);
    expect((await mine.remove(ids[0])).status).toBe(200);
    expect((await listing(mine)).items.map(item => item.sessionID)).toEqual([ids[1]]);
  });

  it('orders by the session update time and filters on indexed metadata', async () => {
    const api = client(personal(`usr-${crypto.randomUUID()}`));
    const parser = await seed(api, {
      client: 'cli',
      title: 'Fix Parser Bug',
      directory: '/repo/a',
      updated: 3000,
    });
    const mobile = await seed(api, {
      client: 'mobile',
      title: 'Mobile chat about parsers',
      directory: '',
      updated: 1000,
    });
    const release = await seed(api, {
      client: 'cli',
      title: 'Release notes',
      directory: '/repo/a',
      updated: 2000,
      archived: true,
    });

    const all = await listing(api);
    expect(all.items.map(item => item.sessionID)).toEqual([parser, release, mobile]);
    expect(all.items[0]).toMatchObject({
      sessionID: parser,
      updatedAt: 3000,
      title: 'Fix Parser Bug',
      client: 'cli',
      directory: '/repo/a',
      archived: false,
      live: false,
    });
    expect(all.items[0].createdAt).toBeGreaterThan(3000);
    // An empty origin directory indexes as no directory.
    expect(all.items.find(item => item.sessionID === mobile)).toMatchObject({ directory: null });

    const ids = async (query: string) =>
      (await listing(api, query)).items.map(item => item.sessionID);
    expect(await ids('?q=parser')).toEqual([parser, mobile]);
    expect(await ids('?q=PARSER')).toEqual([parser, mobile]);
    expect(await ids('?q=absent')).toEqual([]);
    expect(await ids('?client=mobile')).toEqual([mobile]);
    expect(await ids('?client=cli')).toEqual([parser, release]);
    expect(await ids(`?directory=${encodeURIComponent('/repo/a')}`)).toEqual([parser, release]);
    expect(await ids('?archived=true')).toEqual([release]);
    expect(await ids('?archived=false')).toEqual([parser, mobile]);
    expect(await ids('?q=parser&client=cli&archived=false')).toEqual([parser]);

    const page = await listing(api, '?limit=2');
    expect(page.items.map(item => item.sessionID)).toEqual([parser, release]);
    const rest = await listing(api, `?limit=2&cursor=${encodeURIComponent(page.cursor ?? '')}`);
    expect(rest.items.map(item => item.sessionID)).toEqual([mobile]);
    expect(rest.cursor).toBeNull();
  });

  it('follows renames and falls back to the commit time without an update time', async () => {
    const api = client(personal(`usr-${crypto.randomUUID()}`));
    const id = newSessionID();
    const sourceID = crypto.randomUUID();
    expect((await api.register(id, sourceID)).status).toBe(201);
    expect(
      (
        await api.apply(
          id,
          batch(sourceID, 0, 1, [
            {
              op: 'put',
              kind: 'session',
              id,
              value: {
                id,
                title: 'Old name',
                origin: { directory: '/repo/d', client: 'cli' },
                time: { created: 900, updated: 1000 },
              },
            },
          ])
        )
      ).status
    ).toBe(200);
    expect((await listing(api, '?q=old')).items.map(item => item.sessionID)).toEqual([id]);

    const before = Date.now();
    expect(
      (
        await api.apply(
          id,
          batch(sourceID, 1, 2, [
            { op: 'put', kind: 'session', id, value: { id, title: 'New name' } },
          ])
        )
      ).status
    ).toBe(200);

    expect((await listing(api, '?q=old')).items).toEqual([]);
    const renamed = (await listing(api, '?q=new')).items;
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({ sessionID: id, title: 'New name', directory: '/repo/d' });
    expect(renamed[0].updatedAt).toBeGreaterThanOrEqual(before);
  });

  const oldCursor = bytesToBase64url(
    new TextEncoder().encode(JSON.stringify({ createdAt: 1, target: 'x' }))
  );
  it.each([
    '?limit=0',
    '?limit=101',
    '?cursor=bad',
    '?cursor=e30=',
    `?cursor=${oldCursor}`,
    '?q=',
    `?q=${'x'.repeat(201)}`,
    '?client=web',
    '?archived=yes',
  ])('rejects invalid pagination %s', async query => {
    const api = client(personal(`usr-${crypto.randomUUID()}`));
    expect((await api.send('GET', `/v1/sessions${query}`)).status).toBe(400);
  });
});

describe('creator index retries', () => {
  it('keeps an owed index push durable and completes it from the alarm', async () => {
    const userID = `usr-${crypto.randomUUID()}`;
    const api = client(personal(userID));
    const id = newSessionID();
    const sourceID = crypto.randomUUID();
    expect((await api.register(id, sourceID, 'mobile')).status).toBe(201);
    const stub = getSessionSyncDOStub(testEnv, {
      tenant: { type: 'user', id: userID },
      sessionID: id,
    });
    await loseNextIndexPush(stub, userID);
    expect(
      (
        await api.apply(
          id,
          batch(sourceID, 0, 1, [
            {
              op: 'put',
              kind: 'session',
              id,
              value: {
                id,
                title: 'Retried title',
                origin: { directory: '/repo/retry', client: 'mobile' },
                time: { created: 1000, updated: 2000, archived: 1500 },
              },
            },
          ])
        )
      ).status
    ).toBe(200);

    // The refused push is owed, so the list still shows the unindexed session.
    expect((await listing(api)).items[0]).toMatchObject({
      sessionID: id,
      title: null,
      directory: null,
      archived: false,
    });
    expect((await listing(api, '?q=retried')).items).toEqual([]);

    await runInDurableObject(stub, (_instance, state) => {
      expect(drizzle(state.storage).select().from(listMetadata).get()).toMatchObject({
        retry_at: expect.any(Number),
      });
      drizzle(state.storage).update(listMetadata).set({ retry_at: 0 }).run();
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const listed = (await listing(api, '?q=retried')).items;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      sessionID: id,
      title: 'Retried title',
      client: 'mobile',
      directory: '/repo/retry',
      archived: true,
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(drizzle(state.storage).select().from(listMetadata).get()?.owed).toBeNull();
    });
  });
});

import { describe, expect, it } from 'vitest';

import { client, member, newSessionID, personal, type Client } from '../helpers';

async function listing(api: Client, query = '') {
  const response = await api.send('GET', `/v1/sessions${query}`);
  expect(response.status).toBe(200);
  return response.json<{
    version: 1;
    items: {
      sessionID: string;
      tenant: { type: string; id: string };
      createdAt: number;
      live: boolean;
    }[];
    cursor: string | null;
  }>();
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
    expect(all.items[0].createdAt).toBeGreaterThanOrEqual(all.items[1].createdAt);
    expect(all.items.find(item => item.sessionID === ids[1])).toMatchObject({
      tenant: { type: 'organization', id: org },
      live: false,
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

  it.each(['?limit=0', '?limit=101', '?cursor=bad', '?cursor=e30='])(
    'rejects invalid pagination %s',
    async query => {
      const api = client(personal(`usr-${crypto.randomUUID()}`));
      expect((await api.send('GET', `/v1/sessions${query}`)).status).toBe(400);
    }
  );
});

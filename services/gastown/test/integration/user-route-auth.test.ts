import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { signKiloToken, type SignKiloTokenExtra } from '@kilocode/worker-utils/kilo-token';
import { GASTOWN_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { getGastownUserStub } from '../../src/dos/GastownUser.do';
import { getTownDOStub } from '../../src/dos/Town.do';
import type { UserTownRecord } from '../../src/db/tables/user-towns.table';
import type { UserRigRecord } from '../../src/db/tables/user-rigs.table';

const JWT_SECRET = 'test-nextauth-secret-must-be-at-least-32-chars-long';
const routes = [
  ['POST', 'towns', 201],
  ['GET', 'towns', 200],
  ['GET', 'towns/:townId', 200],
  ['POST', 'rigs', 201],
  ['GET', 'rigs/:rigId', 200],
  ['GET', 'towns/:townId/rigs', 200],
  ['DELETE', 'towns/:townId', 200],
  ['DELETE', 'rigs/:rigId', 200],
] as const;

async function headersFor(userId: string, extra: SignKiloTokenExtra = {}) {
  const { token } = await signKiloToken({
    userId,
    secret: JWT_SECRET,
    audience: GASTOWN_AUDIENCE,
    expiresInSeconds: 60,
    extra,
  });
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('Personal user route authorization', () => {
  let callerId: string;
  let ownerId: string;
  let town: UserTownRecord;
  let rig: UserRigRecord;

  beforeEach(async () => {
    callerId = crypto.randomUUID();
    ownerId = crypto.randomUUID();
    const user = getGastownUserStub(env, ownerId);
    town = await user.createTown({ name: 'Private town', owner_user_id: ownerId });
    rig = await user.createRig({
      town_id: town.id,
      name: 'Private rig',
      git_url: 'https://example.com/private.git',
      default_branch: 'main',
    });
    const townStub = getTownDOStub(env, town.id);
    await townStub.setTownId(town.id);
    await runInDurableObject(townStub, async (_instance, state) => {
      await state.storage.put('user-route-auth:sentinel', 'Private work');
    });
  });

  function url(userId: string, path: string) {
    const suffix = path.replace(':townId', town.id).replace(':rigId', rig.id);
    return `http://localhost/api/users/${userId}/${suffix}`;
  }

  function requestBody(method: string) {
    if (method !== 'POST') return undefined;
    return JSON.stringify({
      name: 'New resource',
      town_id: town.id,
      git_url: 'https://example.com/new.git',
    });
  }

  async function expectPrivateState() {
    const user = getGastownUserStub(env, ownerId);
    expect(await user.listTowns()).toEqual([town]);
    expect(await user.listRigs(town.id)).toEqual([rig]);
    const sentinel = await runInDurableObject(getTownDOStub(env, town.id), (_instance, state) =>
      state.storage.get('user-route-auth:sentinel')
    );
    expect(sentinel).toBe('Private work');
  }

  it.each(routes)('rejects another user for %s %s', async (method, path) => {
    const response = await SELF.fetch(url(ownerId, path), {
      method,
      headers: await headersFor(callerId),
      body: requestBody(method),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'Forbidden' });
    await expectPrivateState();
  });

  it.each(routes.filter(([method, path]) => method !== 'POST' || path !== 'towns'))(
    'allows the owner for %s %s',
    async (method, path, status) => {
      const response = await SELF.fetch(url(ownerId, path), {
        method,
        headers: await headersFor(ownerId),
        body: requestBody(method),
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ success: true });
    }
  );

  it('rejects town creation without Gastown access', async () => {
    const response = await SELF.fetch(url(ownerId, 'towns'), {
      method: 'POST',
      headers: await headersFor(ownerId),
      body: requestBody('POST'),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Gastown access required',
    });
    await expectPrivateState();
  });

  it('does not exempt admins without Gastown access', async () => {
    const response = await SELF.fetch(url(ownerId, 'towns'), {
      method: 'POST',
      headers: await headersFor(ownerId, { isAdmin: true }),
      body: requestBody('POST'),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Gastown access required',
    });
    await expectPrivateState();
  });

  it('allows town creation with Gastown access', async () => {
    const response = await SELF.fetch(url(ownerId, 'towns'), {
      method: 'POST',
      headers: await headersFor(ownerId, { gastownAccess: true }),
      body: requestBody('POST'),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { name: 'New resource', owner_user_id: ownerId },
    });
  });

  it.each(['towns', 'towns/:townId/rigs'])(
    'preserves admin support access to another user: %s',
    async path => {
      const response = await SELF.fetch(url(ownerId, path), {
        headers: await headersFor(callerId, { isAdmin: true }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        data: [{ id: expect.any(String) }],
      });
    }
  );

  it.each(routes.filter(([method]) => method !== 'GET'))(
    'rejects cross-user admin writes for %s %s',
    async (method, path) => {
      const response = await SELF.fetch(url(ownerId, path), {
        method,
        headers: await headersFor(callerId, { isAdmin: true }),
        body: requestBody(method),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ success: false, error: 'Forbidden' });
      await expectPrivateState();
    }
  );

  it.each([
    ['POST', 'rigs', 201],
    ['DELETE', 'towns/:townId', 200],
    ['DELETE', 'rigs/:rigId', 200],
  ] as const)('allows admin writes to owned resources for %s %s', async (method, path, status) => {
    const response = await SELF.fetch(url(ownerId, path), {
      method,
      headers: await headersFor(ownerId, { isAdmin: true }),
      body: requestBody(method),
    });

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ success: true });
  });

  it('rejects a missing token', async () => {
    const response = await SELF.fetch(url(ownerId, 'towns'));
    expect(response.status).toBe(401);
    await expectPrivateState();
  });

  it('rejects an invalid token', async () => {
    const response = await SELF.fetch(url(ownerId, 'towns'), {
      headers: { Authorization: 'Bearer invalid' },
    });
    expect(response.status).toBe(401);
    await expectPrivateState();
  });

  it('rejects creation under a nonexistent user', async () => {
    const fakeUserId = crypto.randomUUID();
    const response = await SELF.fetch(url(fakeUserId, 'towns'), {
      method: 'POST',
      headers: await headersFor(callerId),
      body: requestBody('POST'),
    });

    expect(response.status).toBe(403);
    expect(await getGastownUserStub(env, fakeUserId).listTowns()).toEqual([]);
  });

  it('does not destroy an unowned town through the caller user path', async () => {
    const response = await SELF.fetch(url(callerId, 'towns/:townId'), {
      method: 'DELETE',
      headers: await headersFor(callerId),
    });

    expect(response.status).toBe(404);
    await expectPrivateState();
  });
});

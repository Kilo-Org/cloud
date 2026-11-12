import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app';
import type { Env } from '../../src/env';
import { batch, client, newSessionID, personal, testEnv } from '../helpers';

async function fixture() {
  const userID = `synthetic-sync-${crypto.randomUUID()}`;
  const id = newSessionID();
  const sourceID = crypto.randomUUID();
  const handle = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('cloud-agent-next:runtime-credential-proxy')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode('synthetic-hosted-upload-handle-secret'));
  let active = true;
  const authorizeUpload = vi.fn(async (input: { handle: string; sessionID?: string }) => {
    if (!active || input.handle !== handle) return null;
    if (input.sessionID && input.sessionID !== id) throw new Error('Ownership is not available');
    return { userID, expiresAt: Date.now() + 3_600_000 };
  });
  const env: Env = { ...testEnv, CLOUD_AGENT_SYNC_AUTH: { authorizeUpload } };
  const request = (method: string, path: string, body?: unknown) =>
    app.fetch(
      new Request(`https://session-sync.test${path}`, {
        method,
        headers: { authorization: `Bearer ${handle}`, 'content-type': 'application/json' },
        ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }),
      }),
      env
    );
  return {
    userID,
    id,
    sourceID,
    handle,
    authorizeUpload,
    request,
    revoke: () => {
      active = false;
    },
  };
}

describe('Cloud Agent upload-only access', () => {
  it('exchanges a handle, stores a batch, and checks its live authority on every upload', async () => {
    const f = await fixture();
    const exchange = await f.request('POST', '/v1/auth/exchange', { version: 1 });
    expect(exchange.status).toBe(200);
    expect(await exchange.json()).toMatchObject({
      token: f.handle,
      userID: f.userID,
      tenant: { type: 'user', id: f.userID },
    });
    expect(
      (await f.request('PUT', `/v1/sessions/${f.id}`, { version: 1, sourceID: f.sourceID })).status
    ).toBe(201);
    const packet = batch(f.sourceID, 0, 2, [
      { op: 'put', kind: 'session', id: f.id, value: { title: 'Synthetic uploaded session' } },
      {
        op: 'put',
        kind: 'message',
        id: 'msg_synthetic',
        value: { text: 'Synthetic native transcript' },
      },
    ]);
    const first = await f.request('POST', `/v1/sessions/${f.id}/batches`, packet);
    expect(first.status).toBe(200);
    const retry = await f.request('POST', `/v1/sessions/${f.id}/batches`, packet);
    expect(await retry.json()).toEqual(await first.json());
    expect((await f.request('GET', `/v1/sessions/${f.id}`)).status).toBe(200);
    expect(f.authorizeUpload).toHaveBeenCalledTimes(5);
    const reader = client(personal(f.userID));
    const snapshot = await reader.entities(f.id);
    expect(await snapshot.json()).toMatchObject({
      entities: expect.arrayContaining([
        expect.objectContaining({
          kind: 'message',
          value: { text: 'Synthetic native transcript' },
        }),
      ]),
    });
  });

  it.each([
    ['GET', '/entities'],
    ['GET', `/blobs/${'a'.repeat(64)}`],
    ['DELETE', ''],
  ])('refuses %s %s without granting transcript or deletion access', async (method, suffix) => {
    const f = await fixture();
    const response = await f.request(method, `/v1/sessions/${f.id}${suffix}`, {});
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'upload_only' } });
    expect(f.authorizeUpload).not.toHaveBeenCalled();
  });

  it.each(['/commands', '/live-ticket'])(
    'refuses control route %s because live routes accept only sync grants',
    async suffix => {
      const f = await fixture();
      const response = await f.request('POST', `/v1/sessions/${f.id}${suffix}`, {});
      expect(response.status).toBe(401);
      expect(f.authorizeUpload).not.toHaveBeenCalled();
    }
  );

  it('denies uploads after the Cloud Agent authority is revoked', async () => {
    const f = await fixture();
    expect(
      (await f.request('PUT', `/v1/sessions/${f.id}`, { version: 1, sourceID: f.sourceID })).status
    ).toBe(201);
    f.revoke();
    expect(
      (await f.request('POST', `/v1/sessions/${f.id}/batches`, batch(f.sourceID, 0, 1, []))).status
    ).toBe(401);
    const response = await client(personal(f.userID)).state(f.id);
    expect(await response.json()).toMatchObject({ position: 0, revision: 0 });
  });

  it('fails closed and retries ownership that has not reached Cloud yet', async () => {
    const f = await fixture();
    const foreign = newSessionID();
    const response = await f.request('PUT', `/v1/sessions/${foreign}`, {
      version: 1,
      sourceID: f.sourceID,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('3');
    expect((await client(personal(f.userID)).state(foreign)).status).toBe(404);
  });

  it('does not let the exchange body select another organization', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/v1/auth/exchange', {
      version: 1,
      organizationID: crypto.randomUUID(),
    });
    expect(response.status).toBe(403);
  });
});

import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app';
import type { Env } from '../../src/env';
import { batch, client, newSessionID, personal, testEnv } from '../helpers';
import { getSessionSyncDOStub } from '../../src/dos/SessionSyncDO';
import { verifyTicket } from '../../src/live/ticket';

async function fixture(
  options: {
    host?: { cloudAgentSessionId: string };
    rootSessionID?: string;
    liveUnavailable?: boolean;
  } = {}
) {
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
    return {
      userID,
      expiresAt: Date.now() + 3_600_000,
      ...(input.sessionID && options.host ? { host: options.host } : {}),
    };
  });
  const env: Env = {
    ...testEnv,
    CLOUD_AGENT_SYNC_AUTH: {
      authorizeUpload,
      authorizeLive: async () => {
        if (options.liveUnavailable) throw new Error('Synthetic live dependency unavailable');
        return options.host
          ? {
              type: 'allowed',
              authorization: {
                userID,
                workload: 'cloud-agent',
                host: options.host,
                native: {
                  sessionID: id,
                  rootSessionID: options.rootSessionID ?? id,
                  kind: options.rootSessionID ? 'descendant' : 'root',
                },
                liveIdentity: {
                  allocationId: 'synthetic-allocation',
                  providerInstanceId: 'synthetic-provider',
                },
                expiresAt: Date.now() + 60_000,
              },
            }
          : { type: 'denied', code: 'hosted_live_not_enabled' };
      },
    },
  };
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
    env,
    request,
    revoke: () => {
      active = false;
    },
  };
}

describe('Cloud Agent upload-only access', () => {
  it('keeps ordinary hosted upload authorization independent from live authorization availability', async () => {
    const f = await fixture({
      host: { cloudAgentSessionId: `workspace_${crypto.randomUUID()}` },
      liveUnavailable: true,
    });
    expect(
      (await f.request('PUT', `/v1/sessions/${f.id}`, { version: 1, sourceID: f.sourceID })).status
    ).toBe(201);
    expect(
      (await f.request('POST', `/v1/sessions/${f.id}/batches`, batch(f.sourceID, 0, 1, []))).status
    ).toBe(200);
    const response = await f.request('POST', `/v1/sessions/${f.id}/live-ticket`, {
      role: 'runner',
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'auth_unavailable', retryable: true },
    });
  });
  it.each([undefined, 'ses_syntheticregisteredroot'])(
    'binds hosted identity at registration before live traffic: %s',
    async rootSessionID => {
      const host = { cloudAgentSessionId: `workspace_${crypto.randomUUID()}` };
      const f = await fixture({ host, rootSessionID });
      expect(
        (await f.request('PUT', `/v1/sessions/${f.id}`, { version: 1, sourceID: f.sourceID }))
          .status
      ).toBe(201);
      const principal = personal(f.userID);
      const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID: f.id });
      expect(await stub.authorizeLive({ principal, sessionID: f.id })).toMatchObject({
        ok: true,
        value: { host },
      });
      const ticketResponse = await f.request('POST', `/v1/sessions/${f.id}/live-ticket`, {
        role: 'runner',
      });
      expect(ticketResponse.status).toBe(200);
      const body = (await ticketResponse.json()) as { ticket: string };
      expect(await verifyTicket(body.ticket, testEnv, 'session-relay')).toMatchObject({
        workload: 'cloud-agent',
        host,
        native: { sessionID: f.id, kind: rootSessionID ? 'descendant' : 'root' },
        exp: expect.any(Number),
      });
      const presence = await f.request('POST', '/v1/presence/ticket', { role: 'runner' });
      expect(presence.status).toBe(200);
      const presenceBody = (await presence.json()) as { ticket: string };
      expect(await verifyTicket(presenceBody.ticket, testEnv, 'session-presence')).toMatchObject({
        workload: 'cloud-agent',
        host,
      });
      expect(
        (await f.request('POST', `/v1/sessions/${f.id}/live-ticket`, { role: 'controller' })).status
      ).toBe(403);
      expect((await f.request('POST', '/v1/presence/ticket', { role: 'viewer' })).status).toBe(403);
    }
  );

  it('keeps hosting immutable and rejects body-selected hosting metadata', async () => {
    const options = { host: { cloudAgentSessionId: `workspace_${crypto.randomUUID()}` } };
    const original = options.host;
    const f = await fixture(options);
    expect(
      (
        await f.request('PUT', `/v1/sessions/${f.id}`, {
          version: 1,
          sourceID: f.sourceID,
          host: original,
        })
      ).status
    ).toBe(400);
    expect(
      (await f.request('PUT', `/v1/sessions/${f.id}`, { version: 1, sourceID: f.sourceID })).status
    ).toBe(201);
    expect(
      (await f.request('PUT', `/v1/sessions/${f.id}`, { version: 1, sourceID: f.sourceID })).status
    ).toBe(200);
    options.host = { cloudAgentSessionId: `workspace_${crypto.randomUUID()}` };
    const conflict = await f.request('PUT', `/v1/sessions/${f.id}`, {
      version: 1,
      sourceID: f.sourceID,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'hosting_conflict' } });
    const principal = personal(f.userID);
    expect(
      await getSessionSyncDOStub(testEnv, {
        tenant: principal.tenant,
        sessionID: f.id,
      }).authorizeLive({ principal, sessionID: f.id })
    ).toMatchObject({ ok: true, value: { host: original } });
  });

  it('does not let session-less presence or native JSON enroll a stream workspace', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/v1/presence/ticket', {
      role: 'runner',
      chat: { transport: 'relay' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'hosted_live_not_enabled', retryable: false },
    });
  });

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

  it.each(['/commands'])(
    'refuses control route %s because live routes accept only sync grants',
    async suffix => {
      const f = await fixture();
      const response = await f.request('POST', `/v1/sessions/${f.id}${suffix}`, {});
      expect(response.status).toBe(401);
      expect(f.authorizeUpload).not.toHaveBeenCalled();
    }
  );

  it('keeps a valid stream handle refusal terminal and distinct from invalid_grant', async () => {
    const f = await fixture();
    const response = await f.request('POST', `/v1/sessions/${f.id}/live-ticket`, {
      role: 'runner',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'hosted_live_not_enabled', retryable: false },
    });
    expect(f.authorizeUpload).not.toHaveBeenCalled();
  });

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

  it('authorizes status writes through the live hosted-session fence without granting notifications', async () => {
    const f = await fixture();
    expect(
      (await f.request('PUT', `/v1/sessions/${f.id}`, { version: 1, sourceID: f.sourceID })).status
    ).toBe(201);
    expect(
      (
        await f.request('PUT', `/v1/sessions/${f.id}/status`, {
          version: 1,
          sourceID: f.sourceID,
          after: 0,
          status: 'question',
        })
      ).status
    ).toBe(200);
    expect(await (await client(personal(f.userID)).state(f.id)).json()).toMatchObject({
      status: { value: 'question', version: 1 },
    });
    expect((await f.request('POST', '/v1/notifications/ticket')).status).toBe(401);
    f.revoke();
    expect(
      (
        await f.request('PUT', `/v1/sessions/${f.id}/status`, {
          version: 1,
          sourceID: f.sourceID,
          after: 1,
          status: 'idle',
        })
      ).status
    ).toBe(401);
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

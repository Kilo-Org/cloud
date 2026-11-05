import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { app } from '../../src/app';
import type { Env } from '../../src/env';
import { client, grant, personal, testEnv } from '../helpers';

describe('instance command HTTP boundary', () => {
  it('requires a sync grant before instance command submission', async () => {
    const response = await SELF.fetch(
      'https://session-sync.test/v1/presence/instances/host/commands',
      {
        method: 'POST',
        body: JSON.stringify({ type: 'create_session', commandID: 'unauthenticated' }),
      }
    );
    expect(response.status).toBe(401);
  });

  it('returns a typed offline rejection without creating a native session', async () => {
    const api = client(personal(`instance-http-${crypto.randomUUID()}`));
    const response = await api.send('POST', '/v1/presence/instances/offline-host/commands', {
      body: JSON.stringify({ type: 'create_session', commandID: crypto.randomUUID() }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'instance_offline' } });
    const sessions = await api.send('GET', '/v1/sessions');
    expect(await sessions.json()).toMatchObject({ items: [], cursor: null });
  });

  it('rejects an instance frame whose target differs from the authenticated HTTP path', async () => {
    const api = client(personal(`instance-path-${crypto.randomUUID()}`));
    const response = await api.send('POST', '/v1/presence/instances/host-one/commands', {
      body: JSON.stringify({
        type: 'list_directories',
        commandID: crypto.randomUUID(),
        instanceID: 'host-two',
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('returns an unknown outcome when instance RPC transport fails ambiguously', async () => {
    const owner = personal(`instance-outcome-${crypto.randomUUID()}`);
    const namespace = testEnv.SESSION_PRESENCE_DO;
    const env = {
      ...testEnv,
      SESSION_PRESENCE_DO: {
        idFromName: namespace.idFromName.bind(namespace),
        get: () => ({
          command: async () => {
            throw new Error('Synthetic response loss');
          },
        }),
      } as unknown as Env['SESSION_PRESENCE_DO'],
    };
    const response = await app.fetch(
      new Request('https://session-sync.test/v1/presence/instances/host/commands', {
        method: 'POST',
        headers: { authorization: `Bearer ${await grant(owner)}` },
        body: JSON.stringify({ type: 'create_session', commandID: 'ambiguous' }),
      }),
      env
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      commandID: 'ambiguous',
      instanceID: 'host',
      status: 'unknown',
      outcome: 'unknown',
    });
  });
});

import { env, reset, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import type {
  SandboxControlV2,
  StoredProviderPin,
} from '../../src/control-plane/sandbox/sandbox-do.js';
import { allocation } from '../../src/control-plane/sandbox/sqlite-schema.js';
import { createVercelJwksCache } from '../../src/scm-broker/vercel-jwks.js';
import { authenticateVercelForwardToken } from '../../src/scm-broker/vercel-identity.js';
import type { ControlPlaneScmForwardAdmission } from '../../src/shared/control-plane-protocol.js';

const namespace = (env as { SANDBOX_CONTROL: DurableObjectNamespace<SandboxControlV2> })
  .SANDBOX_CONTROL;
const request: ControlPlaneScmForwardAdmission = {
  oidcToken: 'synthetic-invalid-token',
  target: { url: 'https://github.com/acme/repo.git/info/refs', method: 'GET' },
  authorization: {},
};

afterEach(async () => {
  await reset();
});

async function seedVercelAllocation(
  stub: DurableObjectStub<SandboxControlV2>,
  kind: 'starting' | 'stopped'
) {
  await runInDurableObject(stub, async (instance, state) => {
    await instance.getAllocationState();
    await state.storage.put('control_plane_owner', 'owner-test');
    const pin: StoredProviderPin = {
      provider: 'vercel',
      allocationName: 'physical-test',
      configuration: null,
      billing: null,
      byoc: { userId: 'owner-test', credentialId: 'credential-test' },
      containment: { kilocode: true, github: true },
      locator: {
        teamId: 'team-test',
        projectId: 'project-test',
        snapshotId: 'snapshot-test',
        runtimeBuildId: 'runtime-test',
        runtime: 'node24',
      },
    };
    Object.assign(instance, {
      providerPin: pin,
      env: { ...instance.env, WORKER_URL: 'https://worker.test' },
    });
    const db = drizzle(state.storage);
    const current = {
      state: kind,
      allocation_id: 'allocation-test',
      provider_ref: JSON.stringify({
        sandboxName: 'physical-test',
        sessionId: 'provider-test',
      }),
      stop_attempt: 0,
      stop_pending: false,
      provider_pin: JSON.stringify(pin),
    };
    db.insert(allocation)
      .values({ id: 'current', ...current })
      .onConflictDoUpdate({ target: allocation.id, set: current })
      .run();
  });
}

describe('SCM admission in Workers', () => {
  it('does not expose the production router in the minimal integration worker', async () => {
    const response = await SELF.fetch('https://worker.test/scm/vercel/sbx-runtime-dormant');
    expect(response.status).toBe(404);
  });
  it('imports RSA JWKS with platform crypto and verifies only the expected audience', async () => {
    const now = Date.now();
    const issuer = 'https://oidc.vercel.com/synthetic-runtime-test';
    const audience = 'https://worker.test/scm/vercel/sbx-runtime-test';
    const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keys = createVercelJwksCache({
      fetch: async () =>
        Response.json({
          keys: [
            {
              ...signing.publicKey.export({ format: 'jwk' }),
              kid: 'synthetic',
              alg: 'RS256',
              use: 'sig',
            },
          ],
        }),
    });
    const token = jwt.sign(
      {
        iss: issuer,
        aud: audience,
        exp: Math.floor(now / 1000) + 600,
        team_id: 'team-test',
        project_id: 'project-test',
        sandbox_id: 'provider-id-test',
      },
      signing.privateKey,
      { algorithm: 'RS256', keyid: 'synthetic' }
    );
    const expected = {
      issuer,
      audience,
      teamId: 'team-test',
      projectId: 'project-test',
      sandboxId: 'provider-id-test',
      sandboxName: 'physical-test',
    };
    expect(await authenticateVercelForwardToken(token, expected, keys, now)).toMatchObject({
      sandbox_id: 'provider-id-test',
    });
    expect(
      await authenticateVercelForwardToken(
        token,
        { ...expected, audience: 'https://foreign.test' },
        keys,
        now
      )
    ).toBeNull();
  });

  it('rejects a stopped allocation through the real DO RPC', async () => {
    const stub = namespace.getByName('sbx-runtime-stopped');
    await seedVercelAllocation(stub, 'stopped');
    expect(await stub.admitScmForward(request)).toEqual({
      ok: false,
      status: 403,
      code: 'allocation_unavailable',
    });
  });

  it('leaves active allocations unchanged when customer credentials cannot be resolved', async () => {
    const stub = namespace.getByName('sbx-runtime-dormant');
    await seedVercelAllocation(stub, 'starting');
    const before = await stub.getAllocationState();
    expect(await stub.admitScmForward(request)).toEqual({
      ok: false,
      status: 503,
      code: 'byoc_unavailable',
    });
    expect(await stub.getAllocationState()).toEqual(before);
  });
});

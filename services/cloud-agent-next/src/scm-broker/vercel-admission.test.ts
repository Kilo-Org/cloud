import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type { ControlPlaneScmForwardAdmission } from '../shared/control-plane-protocol.js';
import { createControlPlaneCredential } from '../sandbox-control/managed-credential.js';
import {
  admitVercelScmForward,
  admitVercelScmForwardAtLocator,
  type VercelAdmissionContext,
} from './vercel-admission.js';
import { createVercelJwksCache } from './vercel-jwks.js';
import {
  grant,
  time,
  token,
  credential,
  contract,
  expected,
  keysFetch,
  logicalId,
  physicalName,
  jwk,
} from './test-fixtures.js';

function fixture() {
  const scope = grant();
  const context: VercelAdmissionContext = {
    sandboxId: logicalId,
    ownerId: 'user-test',
    provider: 'vercel',
    containmentEnabled: true,
    allocation: {
      kind: 'starting',
      allocationId: 'allocation-test',
      providerRef: JSON.stringify({
        sandboxName: physicalName,
        sessionId: expected.sandboxId,
      }),
    },
    physicalName,
    outboundContainerId: 'allocation-binding',
    byoc: { organizationId: 'org-test', credentialId: 'credential-test' },
    locator: {
      teamId: expected.teamId,
      projectId: expected.projectId,
      snapshotId: 'snapshot-test',
      runtimeBuildId: 'runtime-test',
      runtime: 'node24',
    },
    grants: [scope],
    liveSessionIds: ['workspace-test'],
  };
  const request: ControlPlaneScmForwardAdmission = {
    oidcToken: token(),
    target: {
      url: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      method: 'GET',
    },
    authorization: { authorization: `Bearer ${scope.scm!.alias}` },
  };
  const fetch = keysFetch();
  const resolve = vi.fn(async () => ({
    grant: scope,
    credential: scope.scm!.capability!.credential,
  }));
  const persist = vi.fn();
  const fetchCredential = vi.fn(async () => credential());
  const deps = {
    env: { WORKER_URL: 'https://worker.test' } as Env,
    contract,
    serial: async <T>(operation: () => Promise<T>) => await operation(),
    readContext: vi.fn(async () => structuredClone(context)),
    resolve,
    persist,
    fetchCredential,
    keys: createVercelJwksCache({ fetch, now: () => time }),
    now: () => time,
  };
  return { context, request, deps, scope, fetch, resolve, persist, fetchCredential };
}

describe('dormant serial Vercel SCM admission', () => {
  it('selects the DO from the application locator, never from an alias', async () => {
    const f = fixture();
    f.request.authorization.authorization = `Bearer ${createControlPlaneCredential('sbx-foreign', 'github')}`;
    const admission = vi.fn(async () => ({
      ok: false as const,
      status: 403 as const,
      code: 'credential_denied',
    }));
    const getByName = vi.fn(() => ({ admitScmForward: admission }));
    const namespace = Object.assign({} as Env['SANDBOX_CONTROL'], { getByName });
    expect(
      await admitVercelScmForwardAtLocator({ SANDBOX_CONTROL: namespace }, logicalId, f.request)
    ).toEqual({ ok: false, status: 403, code: 'credential_denied' });
    expect(getByName).toHaveBeenCalledExactlyOnceWith(logicalId);
    expect(admission).toHaveBeenCalledExactlyOnceWith(f.request);
  });
  it('fails closed without a verified provider identity contract', async () => {
    const f = fixture();
    expect(await admitVercelScmForward(f.request, { ...f.deps, contract: null })).toEqual({
      ok: false,
      status: 503,
      code: 'provider_identity_mismatch',
    });
    expect(f.fetchCredential).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it('does not substitute physical names when the immutable ID mapping is unknown', async () => {
    const f = fixture();
    expect(
      await admitVercelScmForward(f.request, {
        ...f.deps,
        contract: { ...contract, sandboxIdForRef: () => null },
      })
    ).toEqual({ ok: false, status: 503, code: 'provider_identity_mismatch' });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it.each([{}, { sandbox_name: physicalName }])(
    'admits clones before route readiness: %j',
    async claims => {
      const f = fixture();
      f.request.oidcToken = token(claims);
      expect(await admitVercelScmForward(f.request, f.deps)).toEqual({
        ok: true,
        authority: {
          type: 'managed',
          provider: 'github',
          capability: 'kgh2.synthetic',
          outboundContainerId: 'allocation-binding',
        },
      });
      expect(f.resolve).toHaveBeenCalledExactlyOnceWith({
        grant: f.scope,
        credential: f.scope.scm!.alias,
        ...f.request.target,
        outboundContainerId: 'allocation-binding',
      });
      expect(f.persist).toHaveBeenCalledExactlyOnceWith(f.scope);
    }
  );
  it.each(['github', 'gitlab', 'bitbucket'] as const)(
    'admits %s through the shared target and carrier policy',
    async purpose => {
      const f = fixture();
      const scope = grant(purpose);
      f.context.grants = [scope];
      f.request.target.url = scope.scm!.gitUrl;
      f.request.authorization =
        purpose === 'gitlab'
          ? { privateToken: scope.scm!.alias }
          : {
              authorization: `Basic ${Buffer.from(`${purpose === 'github' ? 'x-access-token' : 'x-token-auth'}:${scope.scm!.alias}`).toString('base64')}`,
            };
      f.resolve.mockResolvedValueOnce({
        grant: scope,
        credential: scope.scm!.capability!.credential,
      });
      expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({
        ok: true,
        authority: {
          type: 'managed',
          provider: purpose,
          capability: scope.scm!.capability!.credential,
        },
      });
      expect(f.persist).toHaveBeenCalledExactlyOnceWith(scope);
    }
  );
  it.each([
    {},
    { authorization: 'Bearer caller-owned-token' },
    { privateToken: 'caller-owned-token' },
  ])(
    'admits unmanaged requests only through the same identity and target fence: %j',
    async authorization => {
      const f = fixture();
      f.request.authorization = authorization;
      expect(await admitVercelScmForward(f.request, f.deps)).toEqual({
        ok: true,
        authority: { type: 'unmanaged' },
      });
      expect(f.fetchCredential).toHaveBeenCalledOnce();
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.persist).not.toHaveBeenCalled();
      f.request.oidcToken = token({ team_id: 'foreign-team' });
      expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({
        ok: false,
        status: 401,
      });
    }
  );
  it.each([{}, { authorization: 'Bearer caller-owned-token' }, { managed: true }])(
    'retains the exact configured GitLab port for every carrier: %j',
    async carrier => {
      const f = fixture();
      const scope = grant('gitlab');
      f.context.grants = [scope];
      f.request.authorization = 'managed' in carrier ? { privateToken: scope.scm!.alias } : carrier;
      f.request.target.url = scope.scm!.gitUrl;
      f.resolve.mockResolvedValue({
        grant: scope,
        credential: scope.scm!.capability!.credential,
      });
      expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({ ok: true });
      for (const port of ['', ':9443']) {
        f.resolve.mockClear();
        f.request.target.url = `https://gitlab.example${port}/gitlab/acme/repo.git`;
        expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({
          ok: false,
          code: 'target_denied',
        });
        expect(f.resolve).not.toHaveBeenCalled();
      }
    }
  );
  it.each([
    'http://github.com/acme/repo',
    'https://github.com:444/acme/repo',
    'https://attacker.test/acme/repo',
    'https://github.com.attacker.test',
    'https://user@github.com/acme/repo',
  ])('rejects off-list or unsafe targets without resolution: %s', async url => {
    const f = fixture();
    f.request.target.url = url;
    expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({
      ok: false,
      code: 'target_denied',
    });
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it.each(['github', 'bitbucket'] as const)(
    'does not extend %s authority to non-default ports',
    async purpose => {
      const f = fixture();
      const scope = grant(purpose);
      f.context.grants = [scope];
      f.request.authorization = { authorization: `Bearer ${scope.scm!.alias}` };
      const target = new URL(scope.scm!.gitUrl);
      target.port = '8443';
      f.request.target.url = target.href;
      expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({
        ok: false,
        code: 'target_denied',
      });
      expect(f.resolve).not.toHaveBeenCalled();
    }
  );
  it.each(['stopped', 'stopping'] as const)('rejects retired allocation state %s', async kind => {
    const f = fixture();
    f.context.allocation.kind = kind;
    expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({
      ok: false,
      code: 'allocation_unavailable',
    });
    expect(f.fetchCredential).not.toHaveBeenCalled();
  });
  it.each(['foreign-team', 'foreign-project', 'foreign-immutable-id'])(
    'rejects foreign provider identity: %s',
    async foreign => {
      const f = fixture();
      f.request.oidcToken = token(
        foreign === 'foreign-team'
          ? { team_id: foreign }
          : foreign === 'foreign-project'
            ? { project_id: foreign }
            : { sandbox_id: foreign }
      );
      expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({
        ok: false,
        status: 401,
      });
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    }
  );
  it('rejects changed or revoked BYOC accounts', async () => {
    const f = fixture();
    f.fetchCredential.mockResolvedValueOnce({ ...credential(), teamId: 'foreign' });
    expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({
      ok: false,
      code: 'provider_identity_mismatch',
      status: 503,
    });
    f.fetchCredential.mockRejectedValueOnce(new Error('credential revoked'));
    expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({
      ok: false,
      status: 503,
    });
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it.each(['missing-runtime-proxy', 'missing-runtime-authorization'])(
    'rejects cleanup-only rows: %s',
    async kind => {
      const f = fixture();
      if (kind === 'missing-runtime-proxy') delete f.scope.kilo.runtimeProxy;
      else f.scope.kilo.token = 'legacy-kilo-token';
      expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({ ok: false });
      expect(f.resolve).not.toHaveBeenCalled();
    }
  );
  it('rejects a stale grant binding even when its alias still belongs to this DO', async () => {
    const f = fixture();
    f.scope.outboundContainerId = 'retired-allocation-binding';
    f.scope.scm!.capability!.outboundContainerId = 'retired-allocation-binding';
    expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({ ok: false });
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it.each(['foreign-alias', 'raw-capability', 'malformed-alias', 'mixed', 'explicit', 'legacy'])(
    'rejects %s before capability refresh',
    async kind => {
      const f = fixture();
      if (kind === 'foreign-alias')
        f.request.authorization.authorization = `Bearer ${createControlPlaneCredential('sbx_foreign', 'github')}`;
      if (kind === 'raw-capability') f.request.authorization.authorization = 'Bearer kgh2.raw';
      if (kind === 'malformed-alias')
        f.request.authorization.authorization = 'Bearer kcp1.malformed';
      if (kind === 'mixed') f.request.authorization.privateToken = 'caller-token';
      if (kind === 'explicit')
        f.scope.repository = {
          type: 'github',
          repo: 'acme/repo',
          authentication: 'explicit',
          allowUserAuthorization: false,
        };
      if (kind === 'legacy') {
        delete f.scope.scm!.capability;
        f.scope.scm!.nativeToken = 'legacy-token';
      }
      expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({ ok: false });
      expect(f.resolve).not.toHaveBeenCalled();
    }
  );
  it.each(['removed-member', 'expired-grant', 'foreign-owner', 'foreign-org'])(
    'rejects revoked authority: %s',
    async kind => {
      const f = fixture();
      if (kind === 'removed-member') f.context.liveSessionIds = [];
      if (kind === 'expired-grant') f.scope.expiresAt = time;
      if (kind === 'foreign-owner') f.scope.userId = 'foreign-user';
      if (kind === 'foreign-org') f.scope.orgId = 'foreign-org';
      expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({ ok: false });
      expect(f.resolve).not.toHaveBeenCalled();
    }
  );
  it('rechecks allocation identity after key retrieval', async () => {
    const f = fixture();
    f.fetch.mockImplementationOnce(async () => {
      f.context.allocation.allocationId = 'replacement-allocation';
      return Response.json({ keys: [jwk] });
    });
    expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({ ok: false });
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it('keeps BYOC and JWKS I/O outside the serial lifecycle queue', async () => {
    const f = fixture();
    let queued = false;
    f.deps.serial = async operation => {
      expect(queued).toBe(false);
      queued = true;
      try {
        return await operation();
      } finally {
        queued = false;
      }
    };
    f.fetchCredential.mockImplementationOnce(async () => {
      expect(queued).toBe(false);
      return credential();
    });
    f.fetch.mockImplementationOnce(async () => {
      expect(queued).toBe(false);
      return Response.json({ keys: [jwk] });
    });
    f.resolve.mockImplementationOnce(async () => {
      expect(queued).toBe(true);
      return { grant: f.scope, credential: 'kgh2.synthetic' };
    });
    expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({ ok: true });
  });
  it('reports a retryable key-service failure without resolving credentials', async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(new Error('synthetic key outage'));
    expect(await admitVercelScmForward(f.request, f.deps)).toEqual({
      ok: false,
      status: 503,
      code: 'oidc_keys_unavailable',
      retryAfter: 60,
    });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.persist).not.toHaveBeenCalled();
  });
  it('returns 401 for an unknown key from an available issuer', async () => {
    const f = fixture();
    f.request.oidcToken = token({}, 'unknown');
    expect(await admitVercelScmForward(f.request, f.deps)).toEqual({
      ok: false,
      status: 401,
      code: 'invalid_identity',
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it('rechecks membership and expiry after refresh without persisting retired authority', async () => {
    const f = fixture();
    f.resolve.mockImplementationOnce(async () => {
      f.context.liveSessionIds = [];
      return { grant: f.scope, credential: 'kgh2.synthetic' };
    });
    expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({ ok: false });
    expect(f.persist).not.toHaveBeenCalled();
  });
  it('rechecks token expiry after refresh', async () => {
    const f = fixture();
    let now = time;
    f.deps.now = () => now;
    f.resolve.mockImplementationOnce(async () => {
      now += 600_000;
      return { grant: f.scope, credential: 'kgh2.synthetic' };
    });
    expect(await admitVercelScmForward(f.request, f.deps)).toMatchObject({ ok: false });
    expect(f.persist).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type { VercelAdmissionContext } from '../scm-broker/vercel-admission.js';
import { createVercelJwksCache } from '../scm-broker/vercel-jwks.js';
import {
  contract,
  credential,
  expected,
  keysFetch,
  logicalId,
  physicalName,
  time,
  token,
} from '../scm-broker/test-fixtures.js';
import { admitVercelEgressForward, createEgressIdentityCache } from './vercel-egress-admission.js';

const EXPIRES_AT = (time / 1000 + 600) * 1000;

function fixture() {
  const context: VercelAdmissionContext = {
    sandboxId: logicalId,
    ownerId: 'user-test',
    provider: 'vercel',
    containmentEnabled: true,
    allocation: {
      kind: 'connected',
      allocationId: 'allocation-test',
      providerRef: JSON.stringify({ sandboxName: physicalName, sessionId: expected.sandboxId }),
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
    grants: [],
    liveSessionIds: [],
  };
  let now = time;
  const fetch = keysFetch();
  const fetchCredential = vi.fn(async () => credential());
  const readContext = vi.fn(async () => structuredClone(context));
  const deps = {
    env: { WORKER_URL: 'https://worker.test' } as Env,
    contract,
    pin: {
      egressAllowlist: ['example.com', 'github.com', 'worker.test'],
      egressAudit: true,
    } as { egressAllowlist?: string[]; egressAudit?: boolean } | null,
    identities: createEgressIdentityCache(),
    readContext,
    fetchCredential,
    keys: createVercelJwksCache({ fetch, now: () => now }),
    now: () => now,
  };
  return {
    context,
    deps,
    fetch,
    fetchCredential,
    readContext,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const admitted = {
  ok: true,
  policy: {
    allowlist: ['example.com', 'github.com'],
    audit: { allocationRef: 'allocation-test' },
  },
  expiresAt: EXPIRES_AT,
};

describe('Vercel egress admission', () => {
  it('returns no policy for a sandbox without an egress allowlist', async () => {
    const f = fixture();
    f.deps.pin = { egressAudit: false };
    expect(await admitVercelEgressForward({ oidcToken: token() }, f.deps)).toEqual({
      ok: true,
      policy: null,
    });
    expect(f.readContext).not.toHaveBeenCalled();
    expect(f.fetchCredential).not.toHaveBeenCalled();
  });

  it('refuses a malformed request', async () => {
    const f = fixture();
    expect(await admitVercelEgressForward({ oidcToken: '' }, f.deps)).toEqual({
      ok: false,
      status: 401,
      code: 'invalid_request',
    });
  });

  it('returns the pin policy without the Worker host, and audit by allocation id', async () => {
    const f = fixture();
    expect(await admitVercelEgressForward({ oidcToken: token() }, f.deps)).toEqual(admitted);
    f.deps.pin = { egressAllowlist: ['example.com'] };
    const unaudited = await admitVercelEgressForward({ oidcToken: token() }, f.deps);
    expect(unaudited).toEqual({
      ok: true,
      policy: { allowlist: ['example.com'] },
      expiresAt: EXPIRES_AT,
    });
  });

  it('verifies a token once and then reads the live allocation on each call', async () => {
    const f = fixture();
    const oidcToken = token();
    expect(await admitVercelEgressForward({ oidcToken }, f.deps)).toEqual(admitted);
    expect(await admitVercelEgressForward({ oidcToken }, f.deps)).toEqual(admitted);
    expect(f.fetchCredential).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.readContext).toHaveBeenCalledTimes(2);
  });

  it('refuses an expired token after a cached verification', async () => {
    const f = fixture();
    const oidcToken = token();
    await admitVercelEgressForward({ oidcToken }, f.deps);
    f.advance(600_000);
    expect(await admitVercelEgressForward({ oidcToken }, f.deps)).toEqual({
      ok: false,
      status: 401,
      code: 'invalid_identity',
    });
    expect(f.fetchCredential).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['allocation id', (c: VercelAdmissionContext) => (c.allocation.allocationId = 'allocation-2')],
    ['owner', (c: VercelAdmissionContext) => (c.ownerId = 'user-other')],
    [
      'identity binding',
      (c: VercelAdmissionContext) => (c.byoc = { organizationId: 'org-test', credentialId: 'c-2' }),
    ],
  ])('verifies again after a change of the %s', async (_name, change) => {
    const f = fixture();
    const oidcToken = token();
    await admitVercelEgressForward({ oidcToken }, f.deps);
    change(f.context);
    await admitVercelEgressForward({ oidcToken }, f.deps);
    expect(f.fetchCredential).toHaveBeenCalledTimes(2);
  });

  it('verifies again after a change of the provider ref and refuses a token of the old sandbox', async () => {
    const f = fixture();
    const oidcToken = token();
    expect(await admitVercelEgressForward({ oidcToken }, f.deps)).toEqual(admitted);
    f.context.allocation.providerRef = JSON.stringify({
      sandboxName: physicalName,
      sessionId: 'provider-next-id',
    });
    expect(await admitVercelEgressForward({ oidcToken }, f.deps)).toEqual({
      ok: false,
      status: 401,
      code: 'invalid_identity',
    });
    expect(f.fetchCredential).toHaveBeenCalledTimes(2);
  });

  it.each(['stopping', 'stopped'] as const)(
    'refuses a %s allocation even with a cached identity',
    async kind => {
      const f = fixture();
      const oidcToken = token();
      await admitVercelEgressForward({ oidcToken }, f.deps);
      f.context.allocation.kind = kind;
      expect(await admitVercelEgressForward({ oidcToken }, f.deps)).toEqual({
        ok: false,
        status: 403,
        code: 'allocation_unavailable',
      });
      expect(f.fetchCredential).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['no allocation id', (c: VercelAdmissionContext) => (c.allocation.allocationId = null)],
    ['no provider ref', (c: VercelAdmissionContext) => (c.allocation.providerRef = null)],
    ['no owner', (c: VercelAdmissionContext) => (c.ownerId = null)],
    ['another provider', (c: VercelAdmissionContext) => (c.provider = 'cloudflare-containers')],
  ])('refuses an allocation with %s before any verification', async (_name, change) => {
    const f = fixture();
    change(f.context);
    expect(await admitVercelEgressForward({ oidcToken: token() }, f.deps)).toEqual({
      ok: false,
      status: 403,
      code: 'allocation_unavailable',
    });
    expect(f.fetchCredential).not.toHaveBeenCalled();
  });

  it('refuses a token of another sandbox and does not cache it', async () => {
    const f = fixture();
    const oidcToken = token({ sandbox_id: 'provider-other-id' });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await admitVercelEgressForward({ oidcToken }, f.deps)).toEqual({
        ok: false,
        status: 401,
        code: 'invalid_identity',
      });
    }
    expect(f.fetchCredential).toHaveBeenCalledTimes(2);
  });

  it('maps key-service and account failures as the SCM admission does', async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(new Error('synthetic key outage'));
    expect(await admitVercelEgressForward({ oidcToken: token() }, f.deps)).toEqual({
      ok: false,
      status: 503,
      code: 'oidc_keys_unavailable',
      retryAfter: 60,
    });
    const g = fixture();
    g.fetchCredential.mockRejectedValue(new Error('synthetic account outage'));
    expect(await admitVercelEgressForward({ oidcToken: token() }, g.deps)).toEqual({
      ok: false,
      status: 503,
      code: 'byoc_unavailable',
    });
  });

  it('fails closed without a verified provider identity contract', async () => {
    const f = fixture();
    expect(
      await admitVercelEgressForward({ oidcToken: token() }, { ...f.deps, contract: null })
    ).toEqual({ ok: false, status: 503, code: 'provider_identity_mismatch' });
  });
});

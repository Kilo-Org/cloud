import { describe, expect, it } from 'vitest';
import { buildNativeEgressAllowlist, matchesActiveEgressPolicy } from './egress-policy.js';

const env = { WORKER_URL: 'https://agent.example.com' };

describe('buildNativeEgressAllowlist', () => {
  it('includes validated provider routing targets through the canonical builder', () => {
    const host = 'customer-artifacts.s3.us-east-1.amazonaws.com';
    const allowlist = Object.freeze([host, 'packages.example.com']);
    const policy = buildNativeEgressAllowlist({
      allowlist,
      env,
      providerRoutingTargets: [`https://${host}`],
    });
    expect(policy.filter(value => value === host)).toEqual([host]);
    expect(policy).toContain('packages.example.com');
    expect(policy).toEqual([...policy].sort());
    expect(allowlist).toEqual([host, 'packages.example.com']);
  });
  it.each(['http://bucket.example.com', 'https://127.0.0.1', 'https://bucket.example.com:8443'])(
    'rejects an invalid provider routing destination: %s',
    target => {
      expect(() =>
        buildNativeEgressAllowlist({
          allowlist: [],
          env,
          providerRoutingTargets: [target],
        })
      ).toThrow('Sandbox configuration is invalid or unsupported');
    }
  );
  it('keeps loopback Worker upstreams behind the public runtime facade', () => {
    const policy = buildNativeEgressAllowlist({
      allowlist: [],
      env: {
        ...env,
        KILOCODE_BACKEND_BASE_URL: 'http://localhost:3900',
        KILO_OPENROUTER_BASE: 'http://localhost:3910/api',
        KILO_SESSION_INGEST_URL: 'http://localhost:9700',
      },
    });
    expect(policy).toContain('agent.example.com');
    expect(policy).not.toContain('localhost');
    expect(policy).not.toContain('host.docker.internal');
  });

  it('allows required Kilo, control-plane, and HTTPS Git destinations with an empty list', () => {
    const policy = buildNativeEgressAllowlist({ allowlist: [], env });
    expect(policy).toEqual([
      'agent.example.com',
      'api.bitbucket.org',
      'api.github.com',
      'bitbucket.org',
      'codeload.github.com',
      'github.com',
      'gitlab.com',
      'media.githubusercontent.com',
      'objects.githubusercontent.com',
      'raw.githubusercontent.com',
      'session-sync.kiloapps.io',
      'uploads.github.com',
    ]);
    expect(policy).not.toContain('registry.npmjs.org');
    expect(policy).not.toContain('*');
  });

  it('includes only the facade and task repository, without Worker-side upstream hosts', () => {
    const policy = buildNativeEgressAllowlist({
      allowlist: ['EXAMPLE.COM.', 'example.com', 'api.github.com'],
      env: {
        ...env,
        KILOCODE_BACKEND_BASE_URL: 'https://backend.example.com/path',
        KILO_OPENROUTER_BASE: 'https://provider.example.com/api/openrouter',
        KILO_SESSION_INGEST_URL: 'https://ingest.example.com',
      },
      repositoryUrl: 'https://git.company.com/team/repo.git',
    });
    expect(policy).toEqual([...new Set(policy)].sort());
    expect(policy).toEqual(
      expect.arrayContaining(['example.com', 'git.company.com', 'agent.example.com'])
    );
    for (const host of ['backend.example.com', 'provider.example.com', 'ingest.example.com'])
      expect(policy).not.toContain(host);
  });

  it('supports the full public list plus mandatory domains', () => {
    const allowlist = Array.from({ length: 100 }, (_, index) => `domain${index}.example.com`);
    expect(buildNativeEgressAllowlist({ allowlist, env })).toHaveLength(112);
  });

  it.each([
    { env: {} },
    { env: { WORKER_URL: 'http://agent.example.com' } },
    { env: { WORKER_URL: 'https://agent.example.com:8443' } },
    { env: { WORKER_URL: 'https://127.0.0.1' } },
    { env, repositoryUrl: 'ssh://git@git.company.com/repo.git' },
    { env, repositoryUrl: 'https://git.company.com:8443/repo.git' },
    { env, repositoryUrl: 'https://127.0.0.1/repo.git' },
  ])('fails closed for unsupported required destinations: %j', input => {
    expect(() => buildNativeEgressAllowlist({ allowlist: [], ...input })).toThrow(
      'Sandbox configuration is invalid or unsupported'
    );
  });
});

describe('active deployed egress pins', () => {
  const request = {
    egressMode: 'allowlist' as const,
    egressAllowlist: ['packages.example.com'],
    egressAudit: true,
  };
  const selected = {
    egressAllowlist: buildNativeEgressAllowlist({ allowlist: request.egressAllowlist, env }),
    egressAudit: true,
  };
  const stored = {
    egressAllowlist: [...selected.egressAllowlist, 'api.kilo.ai', 'ingest.kilosessions.ai'].sort(),
    egressAudit: true,
  };
  it('accepts an exact old-baseline request without modifying the stored pin', () => {
    const before = structuredClone(stored);
    expect(matchesActiveEgressPolicy({ stored, selected, request, env })).toBe(true);
    expect(stored).toEqual(before);
  });
  it.each([
    { egressAllowlist: [] },
    { egressAllowlist: ['packages.example.com', 'new.example.com'] },
    { egressMode: 'unrestricted' as const, egressAllowlist: undefined },
    { egressAudit: false },
  ])('rejects a changed requested policy: %j', async change => {
    const changed = { ...request, ...change };
    const changedPin = {
      egressAllowlist:
        changed.egressMode === 'allowlist'
          ? buildNativeEgressAllowlist({ allowlist: changed.egressAllowlist ?? [], env })
          : undefined,
      egressAudit: changed.egressAudit,
    };
    expect(matchesActiveEgressPolicy({ stored, selected: changedPin, request: changed, env })).toBe(
      false
    );
  });

  const tokenStored = {
    ...stored,
    egressAllowlist: [...stored.egressAllowlist, 'token-provider.example.com'].sort(),
  };
  it('accepts an old baseline pinned from a token-encoded provider', () => {
    const kiloToken = 'https://token-provider.example.com/api:session-token';
    expect(
      matchesActiveEgressPolicy({ stored: tokenStored, selected, request, env, kiloToken })
    ).toBe(true);
  });
  it.each([
    { kiloToken: 'https://other-provider.example.com/api:session-token' },
    { kiloToken: undefined },
  ])('rejects a token-encoded old baseline for a different provider: %j', ({ kiloToken }) => {
    expect(
      matchesActiveEgressPolicy({ stored: tokenStored, selected, request, env, kiloToken })
    ).toBe(false);
  });
  it('rejects an old baseline after a Worker upstream URL changes', () => {
    const changedEnv = { ...env, KILOCODE_BACKEND_BASE_URL: 'https://backend.example.com' };
    expect(matchesActiveEgressPolicy({ stored, selected, request, env: changedEnv })).toBe(false);
  });
});

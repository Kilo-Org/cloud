import { describe, expect, it } from 'vitest';
import { buildNativeEgressAllowlist } from './egress-policy.js';

const env = { WORKER_URL: 'https://agent.example.com' };

describe('buildNativeEgressAllowlist', () => {
  it('allows required Kilo, control-plane, and HTTPS Git destinations with an empty list', () => {
    const policy = buildNativeEgressAllowlist({ allowlist: [], env });
    expect(policy).toEqual([
      'agent.example.com',
      'api.bitbucket.org',
      'api.github.com',
      'api.kilo.ai',
      'bitbucket.org',
      'codeload.github.com',
      'github.com',
      'gitlab.com',
      'ingest.kilosessions.ai',
      'media.githubusercontent.com',
      'objects.githubusercontent.com',
      'raw.githubusercontent.com',
    ]);
    expect(policy).not.toContain('registry.npmjs.org');
    expect(policy).not.toContain('*');
  });

  it('includes configured infrastructure and the task repository, not arbitrary sandbox env', () => {
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
      expect.arrayContaining([
        'example.com',
        'git.company.com',
        'agent.example.com',
        'backend.example.com',
        'provider.example.com',
        'ingest.example.com',
      ])
    );
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
    { env: { ...env, KILO_OPENROUTER_BASE: 'https://provider.example.com:8443' } },
    { env, repositoryUrl: 'ssh://git@git.company.com/repo.git' },
    { env, repositoryUrl: 'https://git.company.com:8443/repo.git' },
    { env, repositoryUrl: 'https://127.0.0.1/repo.git' },
  ])('fails closed for unsupported required destinations: %j', input => {
    expect(() => buildNativeEgressAllowlist({ allowlist: [], ...input })).toThrow(
      'Sandbox configuration is invalid or unsupported'
    );
  });
});

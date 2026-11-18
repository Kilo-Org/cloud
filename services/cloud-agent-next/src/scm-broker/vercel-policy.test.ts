import { afterEach, describe, expect, it, vi } from 'vitest';
import { grant, contract, time, audience } from './test-fixtures.js';
import type * as VercelIdentityModule from './vercel-identity.js';

vi.mock('./vercel-identity.js', async importOriginal => ({
  ...(await importOriginal<typeof VercelIdentityModule>()),
  verifiedVercelSandboxIdentityContract: contract,
}));

import { addVercelScmForwarding } from './vercel-policy.js';

afterEach(() => vi.useRealTimers());

describe('prepared forwarding-policy composition', () => {
  it('appends matcher-free forwarding after existing transforms without changing wildcard access', () => {
    vi.useFakeTimers();
    vi.setSystemTime(time);
    const transform = {
      match: {
        headers: [{ key: { exact: 'Authorization' }, value: { exact: 'Bearer explicit-alias' } }],
      },
      transform: [{ headers: { Authorization: 'Bearer synthetic-explicit-token' } }],
    };
    const policy = { allow: { 'api.github.com': [transform], '*': [] } };
    const result = addVercelScmForwarding(policy, [grant()], { WORKER_URL: 'https://worker.test' });
    expect(result.allow['api.github.com']).toEqual([transform, { forwardURL: audience }]);
    expect(result.allow['github.com']).toEqual([{ forwardURL: audience }]);
    expect(result.allow['uploads.github.com']).toEqual([{ forwardURL: audience }]);
    expect(result.allow['npm.pkg.github.com']).toEqual([{ forwardURL: audience }]);
    expect(result.allow['*']).toEqual([]);
    expect(policy.allow['api.github.com']).toEqual([transform]);
  });

  it('does not add forwarding to legacy or explicit native-token policies', () => {
    vi.useFakeTimers();
    vi.setSystemTime(time);
    const legacy = grant();
    delete legacy.scm!.capability;
    legacy.scm!.nativeToken = 'synthetic-legacy-token';
    const policy = { allow: { '*': [] } };
    expect(addVercelScmForwarding(policy, [legacy], {})).toBe(policy);
  });

  it('projects configured GitLab ports to one SNI hostname rule without changing grant origins', () => {
    vi.useFakeTimers();
    vi.setSystemTime(time);
    const scope = grant('gitlab');
    const alternatePort = structuredClone(scope);
    alternatePort.scm!.gitUrl = 'https://gitlab.example:9443/gitlab/acme/repo.git';
    alternatePort.scm!.gitlab!.instanceOrigin = 'https://gitlab.example:9443/gitlab';
    alternatePort.scm!.gitlab!.instanceHost = 'gitlab.example:9443';
    const before = structuredClone([scope, alternatePort]);
    const result = addVercelScmForwarding({ allow: { '*': [] } }, [scope, alternatePort], {
      WORKER_URL: 'https://worker.test',
    });
    expect(result.allow).toEqual({ '*': [], 'gitlab.example': [{ forwardURL: audience }] });
    expect([scope, alternatePort]).toEqual(before);
  });

  it('fails closed if the broker URL is not configured', () => {
    vi.useFakeTimers();
    vi.setSystemTime(time);
    expect(() => addVercelScmForwarding({ allow: { '*': [] } }, [grant()], {})).toThrow(
      'requires verified provider identity and transport contracts'
    );
  });
});

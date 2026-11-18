import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  authenticateVercelForwardToken,
  expectedVercelIdentity,
  verifiedVercelSandboxIdentityContract,
} from './vercel-identity.js';
import { createVercelJwksCache } from './vercel-jwks.js';
import {
  time,
  token,
  expected,
  keysFetch,
  physicalName,
  credential,
  contract,
  audience,
  signing,
} from './test-fixtures.js';

describe('Vercel forward identity', () => {
  it('uses the observed sandbox issuer and physical session ID, independent of team slug', () => {
    const contract = verifiedVercelSandboxIdentityContract;
    expect(contract.issuerForTeam({ teamId: 'team_abc123', teamSlug: null })).toBe(
      'https://oidc.vercel.com/team_abc123'
    );
    expect(contract.issuerForTeam({ teamId: 'team_abc123', teamSlug: 'renamed-team' })).toBe(
      'https://oidc.vercel.com/team_abc123'
    );
    expect(contract.issuerForTeam({ teamId: '../other', teamSlug: null })).toBeNull();
    expect(
      contract.sandboxIdForRef({ sandboxName: 'sbx-logical', sessionId: 'sbx_physical' })
    ).toBe('sbx_physical');
  });
  it.each([{}, { sandbox_name: physicalName }])(
    'accepts optional physical names: %j',
    async claims => {
      const fetch = keysFetch();
      const cache = createVercelJwksCache({ fetch, now: () => time });
      expect(
        await authenticateVercelForwardToken(token(claims), expected, cache, time)
      ).not.toBeNull();
      expect(fetch).toHaveBeenCalledWith(
        'https://oidc.vercel.com/synthetic-team/.well-known/jwks',
        expect.objectContaining({ redirect: 'manual' })
      );
    }
  );
  it.each([
    { iss: 'https://attacker.test' },
    { iss: 'https://oidc.vercel.com/foreign' },
    { aud: 'https://other.test' },
    { aud: [audience] },
    { exp: time / 1000 },
    { exp: undefined },
    { team_id: 'foreign-team' },
    { project_id: 'foreign-project' },
    { sandbox_id: 'sbx_logical' },
    { sandbox_id: 'allocation-physical' },
    { sandbox_name: 'sbx_logical' },
  ])('rejects foreign or incomplete identity before key fetch: %j', async claims => {
    const fetch = keysFetch();
    const cache = createVercelJwksCache({ fetch, now: () => time });
    expect(await authenticateVercelForwardToken(token(claims), expected, cache, time)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects invalid signatures, algorithms, not-before claims, and oversized headers', async () => {
    const fetch = keysFetch();
    const cache = createVercelJwksCache({ fetch, now: () => time });
    const valid = token();
    const parts = valid.split('.');
    parts[2] = `${parts[2]?.startsWith('A') ? 'B' : 'A'}${parts[2]?.slice(1)}`;
    expect(await authenticateVercelForwardToken(parts.join('.'), expected, cache, time)).toBeNull();
    expect(
      await authenticateVercelForwardToken(token({ nbf: time / 1000 + 60 }), expected, cache, time)
    ).toBeNull();
    expect(
      await authenticateVercelForwardToken(
        jwt.sign({ aud: audience }, 'secret'),
        expected,
        cache,
        time
      )
    ).toBeNull();
    expect(
      await authenticateVercelForwardToken('a'.repeat(8193), expected, cache, time)
    ).toBeNull();
  });
  it('ignores caller key URLs and fetches only the trusted issuer', async () => {
    const fetch = keysFetch();
    const cache = createVercelJwksCache({ fetch, now: () => time });
    const payload = jwt.decode(token());
    const signed = jwt.sign(payload!, signing.privateKey, {
      algorithm: 'RS256',
      header: {
        alg: 'RS256',
        kid: 'current',
        jku: 'https://attacker.test/jwks',
        x5u: 'https://attacker.test/cert',
      },
    });
    expect(await authenticateVercelForwardToken(signed, expected, cache, time)).not.toBeNull();
    expect(
      fetch.mock.calls.every(
        ([url]) =>
          typeof url === 'string' && url.startsWith('https://oidc.vercel.com/synthetic-team/')
      )
    ).toBe(true);
  });
  it('rejects an unknown signing key after a successful JWKS refresh', async () => {
    const fetch = keysFetch();
    const cache = createVercelJwksCache({ fetch, now: () => time });
    expect(
      await authenticateVercelForwardToken(token({}, 'unknown'), expected, cache, time)
    ).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('resolves only trusted metadata and an explicitly verified provider contract', () => {
    const input = {
      credential: credential(),
      locator: {
        teamId: expected.teamId,
        projectId: expected.projectId,
        snapshotId: 'snapshot',
        runtimeBuildId: 'build',
        runtime: 'node24' as const,
      },
      providerRef: { sandboxName: physicalName, sessionId: expected.sandboxId },
      physicalName,
      audience,
      contract,
    };
    expect(expectedVercelIdentity(input)).toEqual(expected);
    expect(expectedVercelIdentity({ ...input, physicalName: 'sbx_logical' })).toBeNull();
    expect(
      expectedVercelIdentity({ ...input, credential: { ...credential(), teamId: 'foreign' } })
    ).toBeNull();
    expect(
      expectedVercelIdentity({ ...input, credential: { ...credential(), teamSlug: null } })
    ).toBeNull();
    expect(
      expectedVercelIdentity({
        ...input,
        contract: { ...contract, issuerForTeam: () => 'https://attacker.test' },
      })
    ).toBeNull();
  });
});

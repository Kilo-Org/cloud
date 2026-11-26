import { randomUUID } from 'node:crypto';
import { STS_ISSUERS } from '@kilocode/sts-contracts';
import { UTS_SUBJECT_REVOCATION_ENTRYPOINT } from '@kilocode/uts-contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import * as devEntry from '../../src/dev-index';
import * as deployedEntry from '../../src/index';
import { config, env } from './test-env';

/**
 * The `SubjectRevocation` entrypoint through real service bindings in workerd, and the deployed
 * `/internal/` routes. The statements themselves run against Postgres in `test/db/subjects.test.ts`
 * and end to end in `scripts/subjects-e2e.ts`.
 */

const body = () => ({
  operation_id: randomUUID(),
  subject: 'user-1',
  reason: 'access_block',
  actor: 'admin:staff-1',
  source_version: 1,
});

describe('SubjectRevocation entrypoint', () => {
  it('is a named WorkerEntrypoint export of the deployed and the development entry', () => {
    for (const entry of [deployedEntry, devEntry]) {
      expect(Object.keys(entry)).toContain(UTS_SUBJECT_REVOCATION_ENTRYPOINT);
      expect(entry.SubjectRevocation.prototype).toBeInstanceOf(WorkerEntrypoint);
    }
  });

  it('answers a caller it does not list, or a binding without props, unavailable for 60 s', async () => {
    for (const binding of [env.OTHER_SUBJECT_REVOCATION, env.PROPLESS_SUBJECT_REVOCATION]) {
      expect(await binding.revokeSubject(body())).toEqual({
        outcome: 'unavailable',
        retryAfterSeconds: 60,
      });
    }
  });

  it('validates the body and the reason for a listed caller before the statement', async () => {
    expect(await env.SUBJECT_REVOCATION.revokeSubject({ ...body(), actor: 'nobody' })).toEqual({
      outcome: 'invalid_request',
    });
    expect(await env.SUBJECT_REVOCATION.unblockSubject(body())).toEqual({
      outcome: 'refused',
      error: 'reason_not_allowed',
    });
    expect(
      await env.SUBJECT_REVOCATION.endDeviceSessions({ ...body(), reason: 'staff_signout' })
    ).toEqual({ outcome: 'refused', error: 'reason_not_allowed' });
  });
});

describe('deployed /internal/ routes', () => {
  const revoke = (authorization: string) =>
    env.DEFAULT_MINT.fetch(`${config.endpoints.issuer}/internal/subjects/revoke`, {
      method: 'POST',
      headers: { Authorization: authorization },
      body: JSON.stringify(body()),
    });

  it('refuse the development stand-in token: the deployed entry checks STS tokens with @kilocode/verify', async () => {
    const response = await revoke('Bearer uts-dev-sts:web:uts:subjects.revoke');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_token' });
  });

  it('answer 503 temporarily_unavailable, and write nothing, while the STS key set cannot be read', async () => {
    // The development STS issuer has no key set in the test pool, so the fetch fails.
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      client_id: 'web',
      req: 'web',
      scope: 'uts:subjects.revoke',
      env: 'development',
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: 'sts-test-0' })
      .setIssuer(STS_ISSUERS.development)
      .setAudience('uts')
      .setSubject('service:web')
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    const response = await revoke(`Bearer ${token}`);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
  });
});

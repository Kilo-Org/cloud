import { randomUUID } from 'node:crypto';
import { UTS_SUBJECT_REVOCATION_ENTRYPOINT } from '@kilocode/uts-contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';
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
  it('answer 503 temporarily_unavailable while the mint Worker carries no STS token check', async () => {
    const response = await env.DEFAULT_MINT.fetch(
      `${config.endpoints.issuer}/internal/subjects/revoke`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer uts-dev-sts:web:uts:subjects.revoke' },
        body: JSON.stringify(body()),
      }
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
  });
});

import { randomUUID } from 'node:crypto';
import {
  type AppUserCreatedEvent,
  SubjectOperationAnswerSchema,
  UTS_SUBJECT_OPERATIONS,
} from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import { IdentityStoreError } from '../../src/db/client';
import type { FeedEntry } from '../../src/revocation/entries';
import type { FeedPublish } from '../../src/revocation/publish';
import type { SubjectDeps } from '../../src/subjects/operations';
import { type InternalDeps, handleInternalRequest } from '../../src/subjects/routes';
import type { ServiceTokenVerifier } from '../../src/subjects/service-tokens';
import type { OperationRow, SubjectStore } from '../../src/subjects/store';

/**
 * The `/internal/` routes (src/subjects/routes.ts) over a stub store, a stub feed publisher and a
 * stub STS token check: the admission order, every typed outcome and its status, and the
 * fail-closed answers while no verifier or no store exists.
 */

const ISSUER = 'http://localhost:8800';
const T0 = 1_800_000_000_000;

/** The bearer a test sends: `<workload> <scope>`; the stub check reads it back. */
const tokens: ServiceTokenVerifier = async (authorization, scope) => {
  if (authorization === null) return { status: 'missing' };
  const [workload, granted] = authorization.replace(/^Bearer /, '').split(' ');
  if (granted === undefined) return { status: 'invalid' };
  if (granted !== scope) return { status: 'insufficient_scope' };
  return { status: 'verified', workload };
};

const entry: FeedEntry = {
  kind: 'subject',
  id: 'user-1',
  revokedBefore: T0,
  revokedAt: T0,
  expiresAt: T0 + 70 * 60_000,
};

type Stub = {
  operation?: OperationRow | Error;
  publish?: 'published' | 'unpublished';
};

function deps(stub: Stub = {}): InternalDeps & { published: FeedEntry[][] } {
  const published: FeedEntry[][] = [];
  const store: SubjectStore = {
    async applyOperation() {
      if (stub.operation instanceof Error) throw stub.operation;
      return stub.operation ?? { outcome: 'applied', feedEntries: [entry] };
    },
    async importAccount() {
      return { outcome: 'imported' };
    },
    async syncPrimaryEmail() {
      return { outcome: 'refused', error: 'email_taken' };
    },
    async syncMembership() {
      return { outcome: 'applied', feedEntries: [entry] };
    },
    async syncSsoOrganization() {
      return { outcome: 'already_applied', feedEntries: [] };
    },
    async readAppEvents(limit) {
      const event: AppUserCreatedEvent = {
        event_id: randomUUID(),
        type: 'user.created',
        occurred_at: new Date(T0).toISOString(),
        account: { id: `uts_${'c'.repeat(26)}`, primary_email: 'new@example.com' },
      };
      return Array.from({ length: Math.min(limit, 1) }, () => event);
    },
    async ackAppEvents(ids) {
      return ids.length;
    },
  };
  const publish: FeedPublish = async entries => {
    published.push([...entries]);
    return stub.publish ?? 'published';
  };
  const subjects: SubjectDeps = {
    environment: 'development',
    rpId: 'localhost',
    subjects: work => work(store),
    publish,
  };
  return { serviceTokens: tokens, subjects, published };
}

function post(path: string, body: unknown, bearer: string | null) {
  return new Request(`${ISSUER}${path}`, {
    method: 'POST',
    headers: bearer === null ? {} : { Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

function operationBody(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: randomUUID(),
    subject: 'user-1',
    reason: 'access_block',
    actor: 'admin:staff-1',
    source_version: 3,
    ...overrides,
  };
}

const REVOKE = 'web uts:subjects.revoke';

async function call(request: Request, routeDeps: InternalDeps) {
  const response = await handleInternalRequest(request, new URL(request.url).pathname, routeDeps);
  if (response === null) throw new Error('not an internal route');
  return {
    status: response.status,
    retryAfter: response.headers.get('Retry-After'),
    body: await response.json(),
  };
}

describe('admission', () => {
  it('leaves other paths to the next handler and takes POST only', async () => {
    const request = post('/internal/subjects/unknown', {}, REVOKE);
    expect(await handleInternalRequest(request, '/internal/subjects/unknown', deps())).toBeNull();
    const get = new Request(`${ISSUER}/internal/subjects/revoke`);
    expect((await call(get, deps())).status).toBe(405);
  });

  it('answers 503 with Retry-After on every route while the STS check cannot run, and writes nothing', async () => {
    const unavailable: ServiceTokenVerifier = async () => ({
      status: 'unavailable',
      retryAfterSeconds: 60,
    });
    const routeDeps = { ...deps(), serviceTokens: unavailable };
    for (const path of [
      ...Object.keys(UTS_SUBJECT_OPERATIONS).map(name => `/internal/subjects/${name}`),
      '/internal/accounts/import',
      '/internal/authority/email',
      '/internal/app-events/read',
      '/internal/app-events/ack',
    ]) {
      const answer = await call(post(path, operationBody(), REVOKE), routeDeps);
      expect({ path, ...answer }).toEqual({
        path,
        status: 503,
        retryAfter: '60',
        body: { error: 'temporarily_unavailable' },
      });
    }
    expect(routeDeps.published).toEqual([]);
  });

  it('refuses a missing or invalid token, a scope of another route and another workload', async () => {
    const path = '/internal/subjects/end-browser-sessions';
    const body = operationBody({ reason: 'staff_signout' });
    expect((await call(post(path, body, null), deps())).status).toBe(401);
    expect((await call(post(path, body, 'web'), deps())).status).toBe(401);
    expect((await call(post(path, body, REVOKE), deps())).status).toBe(403);
    expect((await call(post(path, body, 'o11y uts:browser-sessions.end'), deps())).status).toBe(
      403
    );
    expect((await call(post(path, body, 'web uts:browser-sessions.end'), deps())).status).toBe(200);
  });

  it('answers 503 while the identity store is not bound', async () => {
    const answer = await call(post('/internal/subjects/revoke', operationBody(), REVOKE), {
      serviceTokens: tokens,
      subjects: null,
    });
    expect(answer).toMatchObject({ status: 503, retryAfter: '60' });
  });
});

describe('subject operation outcomes', () => {
  it('answers 200 only once a vouching feed object took the entries', async () => {
    const body = operationBody();
    const routeDeps = deps();
    const answer = await call(post('/internal/subjects/revoke', body, REVOKE), routeDeps);
    expect(answer).toEqual({
      status: 200,
      retryAfter: null,
      body: { outcome: 'applied', operation_id: body.operation_id },
    });
    expect(SubjectOperationAnswerSchema.parse(answer.body)).toBeTruthy();
    expect(routeDeps.published).toEqual([[entry]]);
    const unvouched = await call(
      post('/internal/subjects/revoke', body, REVOKE),
      deps({ publish: 'unpublished' })
    );
    expect(unvouched).toMatchObject({ status: 503, retryAfter: '2' });
  });

  it('maps unblock_too_soon to a retryable 409, and a deleted account to a final one', async () => {
    const body = operationBody({ reason: 'access_unblock' });
    const early = await call(
      post('/internal/subjects/unblock', body, REVOKE),
      deps({ operation: { outcome: 'retry_later', retryAfterSeconds: 37 } })
    );
    expect(early).toEqual({
      status: 409,
      retryAfter: '37',
      body: { outcome: 'retry_later', error: 'unblock_too_soon', operation_id: body.operation_id },
    });
    const deleted = await call(
      post('/internal/subjects/unblock', body, REVOKE),
      deps({ operation: { outcome: 'refused', error: 'account_deleted' } })
    );
    expect(deleted).toEqual({
      status: 409,
      retryAfter: null,
      body: { outcome: 'refused', error: 'account_deleted' },
    });
  });

  it('refuses a reason of another operation with 409 and a malformed body with 400', async () => {
    const routeDeps = deps();
    const wrongReason = await call(
      post('/internal/subjects/unblock', operationBody({ reason: 'access_block' }), REVOKE),
      routeDeps
    );
    expect(wrongReason).toEqual({
      status: 409,
      retryAfter: null,
      body: { outcome: 'refused', error: 'reason_not_allowed' },
    });
    for (const bad of [
      operationBody({ actor: 'user:has space' }),
      operationBody({ actor: 'system:UPPER' }),
      operationBody({ source_version: 2 ** 53 }),
      operationBody({ source_version: -1 }),
      operationBody({ operation_id: 'not-a-uuid' }),
      operationBody({ extra: true }),
    ]) {
      expect((await call(post('/internal/subjects/revoke', bad, REVOKE), routeDeps)).status).toBe(
        400
      );
    }
    expect(routeDeps.published).toEqual([]);
  });

  it('asks for a retry on a retryable store failure and answers 400 for a reused operation id', async () => {
    const retryable = new IdentityStoreError('retryable', {
      sqlState: '57014',
      constraint: undefined,
      table: undefined,
      systemCode: undefined,
    });
    const reused = new IdentityStoreError('permanent', {
      sqlState: '22023',
      constraint: undefined,
      table: undefined,
      systemCode: undefined,
    });
    const path = '/internal/subjects/revoke';
    expect(
      await call(post(path, operationBody(), REVOKE), deps({ operation: retryable }))
    ).toMatchObject({ status: 503, retryAfter: '2' });
    expect(
      (await call(post(path, operationBody(), REVOKE), deps({ operation: reused }))).status
    ).toBe(400);
  });
});

describe('import, authority sync and app events', () => {
  it('maps each answer to its status', async () => {
    const importBody = {
      app_user_id: 'oauth/google:1',
      primary_email: 'user@example.com',
      status: 'active',
      verified_identities: [],
      sso_authority: null,
      passkeys: [],
      source_version: 0,
    };
    expect(
      await call(post('/internal/accounts/import', importBody, 'web uts:accounts.import'), deps())
    ).toMatchObject({ status: 200, body: { outcome: 'imported', account_id: 'oauth/google:1' } });
    expect(
      (
        await call(
          post(
            '/internal/accounts/import',
            { ...importBody, app_user_id: `uts_${'d'.repeat(26)}` },
            'web uts:accounts.import'
          ),
          deps()
        )
      ).status
    ).toBe(400);

    const sync = 'web uts:authority.sync';
    const common = { operation_id: randomUUID(), actor: 'system:scim', source_version: 4 };
    expect(
      await call(
        post(
          '/internal/authority/email',
          { ...common, subject: 'u', primary_email: 'a@example.com' },
          sync
        ),
        deps()
      )
    ).toMatchObject({ status: 409, body: { outcome: 'refused', error: 'email_taken' } });
    const routeDeps = deps();
    expect(
      await call(
        post(
          '/internal/authority/membership',
          { ...common, subject: 'u', app_organization_id: randomUUID(), role: null },
          sync
        ),
        routeDeps
      )
    ).toMatchObject({
      status: 200,
      body: { outcome: 'applied', operation_id: common.operation_id },
    });
    expect(routeDeps.published).toEqual([[entry]]);

    const events = 'web uts:app-events.read';
    const read = await call(post('/internal/app-events/read', { limit: 5 }, events), deps());
    expect(read).toMatchObject({ status: 200, body: { events: [{ type: 'user.created' }] } });
    const ack = await call(
      post('/internal/app-events/ack', { event_ids: [randomUUID(), randomUUID()] }, events),
      deps()
    );
    expect(ack).toEqual({ status: 200, retryAfter: null, body: { acknowledged: 2 } });
    expect(
      (await call(post('/internal/app-events/read', { limit: 101 }, events), deps())).status
    ).toBe(400);
  });
});

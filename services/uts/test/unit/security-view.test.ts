import { type SecurityView, SecurityViewSchema, UTS_SECURITY_PATH } from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import { IdentityStoreError } from '../../src/db/client';
import {
  type SecurityViewDeps,
  type SecurityViewResult,
  handleSecurityRequest,
} from '../../src/notices/security-view';

const CALLER = { accountId: 'oauth/user-1', grantId: '00000000-0000-4000-8000-000000000001' };

const EMPTY_VIEW: SecurityView = {
  sign_ins: [],
  sessions: [],
  credentials: {
    passkeys: [],
    sign_in_methods: [],
    pats: [],
    third_party_clients: [],
    ci_trust_policies: [],
  },
  notices: [],
};

function deps(read: () => Promise<SecurityViewResult>): SecurityViewDeps {
  return {
    authenticate: async request =>
      request.headers.get('Authorization') === 'Bearer ok'
        ? { status: 'ok', caller: CALLER }
        : { status: 'refused', response: new Response(null, { status: 401 }) },
    read,
  };
}

const request = (method = 'GET', authorization = 'Bearer ok') =>
  new Request(`https://uts.test${UTS_SECURITY_PATH}`, {
    method,
    headers: { Authorization: authorization },
  });

function storeError(failure: 'retryable' | 'permanent') {
  return new IdentityStoreError(failure, {
    sqlState: failure === 'retryable' ? '08006' : '42501',
    constraint: undefined,
    table: undefined,
    systemCode: undefined,
  });
}

describe('GET /account/security', () => {
  it('answers null for another path', async () => {
    expect(
      await handleSecurityRequest(
        request(),
        '/account/pats',
        deps(async () => ({ outcome: 'invalid_session' }))
      )
    ).toBeNull();
  });

  it('allows GET only', async () => {
    const response = await handleSecurityRequest(
      request('POST'),
      UTS_SECURITY_PATH,
      deps(async () => ({ outcome: 'listed', view: EMPTY_VIEW }))
    );
    expect(response?.status).toBe(405);
    expect(response?.headers.get('Allow')).toBe('GET');
  });

  it('answers the bearer check refusal without reading', async () => {
    let reads = 0;
    const response = await handleSecurityRequest(
      request('GET', 'Bearer other'),
      UTS_SECURITY_PATH,
      deps(async () => {
        reads += 1;
        return { outcome: 'invalid_session' };
      })
    );
    expect(response?.status).toBe(401);
    expect(reads).toBe(0);
  });

  it('lists the view, even an empty one, and nothing caches it', async () => {
    const response = await handleSecurityRequest(
      request(),
      UTS_SECURITY_PATH,
      deps(async () => ({ outcome: 'listed', view: EMPTY_VIEW }))
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Cache-Control')).toBe('no-store');
    expect(SecurityViewSchema.parse(await response?.json())).toEqual(EMPTY_VIEW);
  });

  it('refuses a token whose session has ended', async () => {
    const response = await handleSecurityRequest(
      request(),
      UTS_SECURITY_PATH,
      deps(async () => ({ outcome: 'invalid_session' }))
    );
    expect(response?.status).toBe(401);
    expect(response?.headers.get('WWW-Authenticate')).toBe('Bearer error="invalid_token"');
  });

  it('answers 503 for a retryable store failure and 500 for a permanent one', async () => {
    for (const [failure, status] of [
      ['retryable', 503],
      ['permanent', 500],
    ] as const) {
      const response = await handleSecurityRequest(
        request(),
        UTS_SECURITY_PATH,
        deps(async () => {
          throw storeError(failure);
        })
      );
      expect(response?.status).toBe(status);
    }
  });
});

jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('./pending', () => ({
  consumeClaudeBillingPending: jest.fn(),
  saveClaudeBillingPending: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/claude-billing/operator', () => ({
  createClaudeUserProfile: jest.fn(async () => `uprof_${crypto.randomUUID()}`),
  isClaudeOperatorConfigured: jest.fn(() => false),
}));
jest.mock('./access', () => ({
  canManageClaudeBillingOrganization: jest.fn(),
  isClaudeBillingOrganizationMember: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/auth/claude/feature-flag.server', () => ({
  isClaudePlatformOAuthEnabled: jest.fn(async () => true),
}));
jest.mock('./protocol', () => {
  class ClaudeBillingExchangeError extends Error {
    constructor(readonly oauthError: string | null) {
      super('Claude billing exchange failed');
    }
  }
  return {
    exchangeClaudeBillingCode: jest.fn(),
    pushClaudeAuthorizationRequest: jest.fn(async () => 'http://127.0.0.1/oauth/authorize'),
    ClaudeBillingExchangeError,
  };
});
import { beforeEach, describe, expect, it } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { claude_billing_connections, byok_api_keys, type User } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import type { FailureResult } from '@kilocode/web-shared/lib/maybe-result';
import type { ClaudeBillingOwner } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { consumeClaudeBillingPending, saveClaudeBillingPending } from './pending';
import { canManageClaudeBillingOrganization, isClaudeBillingOrganizationMember } from './access';
import { isClaudePlatformOAuthEnabled } from '@kilocode/web-shared/lib/auth/claude/feature-flag.server';
import {
  exchangeClaudeBillingCode,
  pushClaudeAuthorizationRequest,
  ClaudeBillingExchangeError,
} from './protocol';
import { GET } from '@/app/claude/billing/callback/route';
import { GET as connect } from '@/app/claude/billing/connect/route';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import {
  clearClaudeBillingRefusal,
  getGrantedClaudeBillingConnection,
  markClaudeBillingUnavailable,
  recordClaudeBillingRefusal,
  removeClaudeBillingGrant,
  shareClaudeBillingConnection,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';

beforeEach(() => {
  jest.mocked(getUserFromAuth).mockReset();
  jest.mocked(saveClaudeBillingPending).mockClear();
  jest.mocked(pushClaudeAuthorizationRequest).mockClear();
  jest.mocked(isClaudePlatformOAuthEnabled).mockReset().mockResolvedValue(true);
  jest.mocked(canManageClaudeBillingOrganization).mockReset().mockResolvedValue(true);
  jest.mocked(isClaudeBillingOrganizationMember).mockReset().mockResolvedValue(true);
  jest.mocked(exchangeClaudeBillingCode).mockReset().mockResolvedValue('ocon_new');
});

type Scope = 'personal' | 'member' | 'shared_services';

/** A session the standard authorized path accepts. */
function signedIn(user: User) {
  jest.mocked(getUserFromAuth).mockResolvedValue({ user, authFailedResponse: null });
}

/** A request with no usable session: signed out, or a revoked web session. */
function signedOut() {
  jest.mocked(getUserFromAuth).mockResolvedValue({
    user: null,
    authFailedResponse: NextResponse.json<FailureResult<string>>(
      { success: false, error: 'Reauthentication required' },
      { status: 401 }
    ),
  });
}

/** A session the standard authorized path refuses: a blocked or blacklisted account. */
function refusedAccount() {
  jest.mocked(getUserFromAuth).mockResolvedValue({
    user: null,
    authFailedResponse: NextResponse.json<FailureResult<string>>(
      { success: false, error: 'Access denied (R1)' },
      { status: 403 }
    ),
    authorizationRefused: true,
  });
}

async function seed(scope: Scope = 'personal') {
  const user = await insertTestUser();
  const org =
    scope === 'personal' ? null : await createTestOrganization('Claude callback', user.id, 0);
  if (scope !== 'personal' && !org) throw new Error('Missing organization fixture');
  const owner: ClaudeBillingOwner =
    scope === 'personal'
      ? { kind: 'personal', kiloUserId: user.id }
      : scope === 'member'
        ? { kind: 'member', kiloUserId: user.id, organizationId: org?.id ?? '' }
        : { kind: 'shared_services', organizationId: org?.id ?? '' };
  const [row] = await db
    .insert(claude_billing_connections)
    .values({
      kilo_user_id: scope === 'shared_services' ? null : user.id,
      organization_id: org?.id ?? null,
      user_profile_id: `uprof_${user.id}`,
      created_by: user.id,
    })
    .returning();
  if (!row) throw new Error('Missing connection fixture');
  await db.insert(byok_api_keys).values([
    {
      kilo_user_id: user.id,
      organization_id: null,
      provider_id: 'anthropic',
      created_by: user.id,
    },
    ...(org
      ? [
          {
            kilo_user_id: null,
            organization_id: org.id,
            provider_id: 'anthropic',
            created_by: user.id,
          },
        ]
      : []),
  ]);
  signedIn(user);
  jest.mocked(consumeClaudeBillingPending).mockResolvedValue({
    kiloUserId: user.id,
    owner,
    returnPath: '/byok',
    state: 'expected',
    codeVerifier: 'verifier',
    userProfileId: row.user_profile_id,
    connectionVersion: row.updated_at,
  });
  return { user, row, org, owner };
}

function callback(query = 'state=expected&code=one-use-code') {
  return GET(new NextRequest(`http://localhost/claude/billing/callback?${query}`));
}
async function state(id: string) {
  const [row] = await db
    .select()
    .from(claude_billing_connections)
    .where(eq(claude_billing_connections.id, id));
  return row;
}
async function anthropicKeys(userId: string) {
  return await db
    .select()
    .from(byok_api_keys)
    .where(and(eq(byok_api_keys.provider_id, 'anthropic'), eq(byok_api_keys.created_by, userId)));
}

describe('Claude billing callback', () => {
  it.each(['personal', 'member', 'shared_services'] as const)(
    'connects the authorized %s owner and deletes only a personal pasted key',
    async scope => {
      const fixture = await seed(scope);
      const response = await callback();
      expect(response.headers.get('location')).toContain(
        scope === 'shared_services' ? 'claude_billing_shared=connected' : 'claude_billing=connected'
      );
      expect(isClaudePlatformOAuthEnabled).toHaveBeenCalledWith(fixture.user.google_user_email);
      expect(await state(fixture.row.id)).toMatchObject({
        status: 'connected',
        connection_id: 'ocon_new',
      });
      const keys = await anthropicKeys(fixture.user.id);
      expect(keys.map(key => key.organization_id)).toEqual(
        scope === 'personal' ? [] : [null, fixture.org?.id]
      );
    }
  );

  it('leaves the key and row unchanged when state does not match', async () => {
    const { row } = await seed();
    expect((await callback('state=wrong&code=c')).headers.get('location')).toContain(
      'claude_billing=failed'
    );
    expect(await state(row.id)).toMatchObject({ status: 'pending', connection_id: null });
    expect(exchangeClaudeBillingCode).not.toHaveBeenCalled();
  });

  it('refuses a callback completed in another Kilo session', async () => {
    await seed();
    signedIn(await insertTestUser());
    expect((await callback()).headers.get('location')).toContain('claude_billing=failed');
    expect(exchangeClaudeBillingCode).not.toHaveBeenCalled();
  });

  it('rechecks the shared-services role after approval', async () => {
    const { row } = await seed('shared_services');
    jest.mocked(canManageClaudeBillingOrganization).mockResolvedValue(false);
    expect((await callback()).headers.get('location')).toContain('claude_billing_shared=forbidden');
    expect(await state(row.id)).toMatchObject({ status: 'pending' });
    expect(exchangeClaudeBillingCode).not.toHaveBeenCalled();
  });

  it('records the admin who links shared services again as its connector', async () => {
    const { row } = await seed('shared_services');
    const nextAdmin = await insertTestUser();
    const pending = await consumeClaudeBillingPending();
    if (!pending) throw new Error('Missing pending fixture');
    signedIn(nextAdmin);
    jest.mocked(consumeClaudeBillingPending).mockResolvedValue({
      ...pending,
      kiloUserId: nextAdmin.id,
    });
    expect((await callback()).headers.get('location')).toContain('claude_billing_shared=connected');
    expect(await state(row.id)).toMatchObject({ status: 'connected', created_by: nextAdmin.id });
  });

  it('rechecks membership for a member connection after approval', async () => {
    const { row } = await seed('member');
    jest.mocked(isClaudeBillingOrganizationMember).mockResolvedValue(false);
    expect((await callback()).headers.get('location')).toContain('claude_billing=forbidden');
    expect(await state(row.id)).toMatchObject({ status: 'pending' });
    expect(exchangeClaudeBillingCode).not.toHaveBeenCalled();
  });

  it('does not complete a connection while the Claude platform OAuth flag is off', async () => {
    const { row } = await seed();
    jest.mocked(isClaudePlatformOAuthEnabled).mockResolvedValue(false);
    expect((await callback()).headers.get('location')).toContain('claude_billing=forbidden');
    expect(await state(row.id)).toMatchObject({ status: 'pending', connection_id: null });
    expect(exchangeClaudeBillingCode).not.toHaveBeenCalled();
  });

  it('does not start a connection while the Claude platform OAuth flag is off', async () => {
    const { user } = await seed();
    jest.mocked(isClaudePlatformOAuthEnabled).mockResolvedValue(false);
    const response = await connect(
      new NextRequest('http://localhost/claude/billing/connect?return=%2Fbyok')
    );
    expect(response.headers.get('location')).toContain('claude_billing=forbidden');
    expect(isClaudePlatformOAuthEnabled).toHaveBeenCalledWith(user.google_user_email);
  });

  it.each(['connect', 'callback'])(
    'refuses %s when the session has no authorized account',
    async flow => {
      const { row } = await seed();
      signedOut();

      const response =
        flow === 'connect'
          ? await connect(new NextRequest('http://localhost/claude/billing/connect?return=%2Fbyok'))
          : await callback();
      const location = new URL(response.headers.get('location') ?? '');
      if (flow === 'connect') {
        expect(location.pathname).toBe('/users/sign_in');
        expect(location.searchParams.get('callbackPath')).toBe('/byok');
        expect(saveClaudeBillingPending).not.toHaveBeenCalled();
      } else {
        expect(location.searchParams.get('claude_billing')).toBe('failed');
      }
      expect(exchangeClaudeBillingCode).not.toHaveBeenCalled();
      expect(await state(row.id)).toMatchObject({ status: 'pending', connection_id: null });
    }
  );

  it('does not create a profile or start an authorization push for a refused account', async () => {
    const user = await insertTestUser();
    signedIn(user);
    refusedAccount();

    const response = await connect(new NextRequest('http://localhost/claude/billing/connect'));

    expect(new URL(response.headers.get('location') ?? '').searchParams.get('claude_billing')).toBe(
      'forbidden'
    );
    expect(saveClaudeBillingPending).not.toHaveBeenCalled();
    expect(pushClaudeAuthorizationRequest).not.toHaveBeenCalled();
    const rows = await db
      .select()
      .from(claude_billing_connections)
      .where(eq(claude_billing_connections.kilo_user_id, user.id));
    expect(rows).toEqual([]);
  });

  it('does not exchange the code or write the connection for a refused account', async () => {
    const { row } = await seed();
    refusedAccount();

    const response = await callback();

    expect(new URL(response.headers.get('location') ?? '').searchParams.get('claude_billing')).toBe(
      'forbidden'
    );
    expect(exchangeClaudeBillingCode).not.toHaveBeenCalled();
    expect(await state(row.id)).toMatchObject({ status: 'pending', connection_id: null });
  });

  it('reports a refused shared-services callback under the shared-services query', async () => {
    const { row } = await seed('shared_services');
    refusedAccount();

    const response = await callback();

    expect(
      new URL(response.headers.get('location') ?? '').searchParams.get('claude_billing_shared')
    ).toBe('forbidden');
    expect(exchangeClaudeBillingCode).not.toHaveBeenCalled();
    expect(await state(row.id)).toMatchObject({ status: 'pending' });
  });

  it.each(['access_denied', 'user_profile_already_linked'])(
    'does not change a connection for callback error %s',
    async error => {
      const { row } = await seed();
      const response = await callback(`state=expected&error=${error}`);
      expect(response.headers.get('location')).toContain(
        error === 'access_denied' ? 'claude_billing=declined' : 'claude_billing=already_linked'
      );
      expect(await state(row.id)).toMatchObject({ status: 'pending', connection_id: null });
      expect(exchangeClaudeBillingCode).not.toHaveBeenCalled();
    }
  );

  it('handles a collision raised during the code exchange', async () => {
    await seed();
    jest
      .mocked(exchangeClaudeBillingCode)
      .mockRejectedValue(new ClaudeBillingExchangeError('user_profile_already_linked'));
    expect((await callback()).headers.get('location')).toContain('claude_billing=already_linked');
  });

  it('does not undo a removal that happens during approval', async () => {
    const { row, user } = await seed();
    await db
      .update(claude_billing_connections)
      .set({ status: 'removed', updated_at: '2030-01-01T00:00:00Z' })
      .where(eq(claude_billing_connections.id, row.id));
    expect((await callback()).headers.get('location')).toContain('claude_billing=failed');
    expect(await state(row.id)).toMatchObject({ status: 'removed', connection_id: null });
    expect((await anthropicKeys(user.id)).map(key => key.provider_id)).toEqual(['anthropic']);
  });

  it('keeps normalized return paths on Kilo at both ends of the connection flow', async () => {
    await seed();
    const pending = await consumeClaudeBillingPending();
    if (!pending) throw new Error('Missing pending fixture');
    jest
      .mocked(consumeClaudeBillingPending)
      .mockResolvedValue({ ...pending, returnPath: '/..//external.invalid/path' });
    const end = new URL((await callback('state=wrong')).headers.get('location') ?? '');
    expect(end.origin).toBe(new URL(APP_URL).origin);
    expect(end.pathname).toBe('/byok');
    jest.mocked(isClaudePlatformOAuthEnabled).mockResolvedValue(false);
    const start = new URL(
      (
        await connect(
          new NextRequest(
            'http://localhost/claude/billing/connect?return=%2F..%2F%2Fexternal.invalid%2Fpath'
          )
        )
      ).headers.get('location') ?? ''
    );
    expect(start.origin).toBe(new URL(APP_URL).origin);
    expect(start.pathname).toBe('/byok');
  });

  it('completes a reconnect while ordinary requests update refusal bookkeeping', async () => {
    const { row } = await seed();
    const connectedAt = '2026-01-01T00:00:00Z';
    const [connected] = await db
      .update(claude_billing_connections)
      .set({ status: 'connected', connected_at: connectedAt })
      .where(eq(claude_billing_connections.id, row.id))
      .returning();
    if (!connected) throw new Error('Missing connected fixture');
    const pending = await consumeClaudeBillingPending();
    if (!pending) throw new Error('Missing pending fixture');
    jest
      .mocked(consumeClaudeBillingPending)
      .mockResolvedValue({ ...pending, connectionVersion: connected.updated_at });
    await clearClaudeBillingRefusal(row.user_profile_id, connectedAt);
    await recordClaudeBillingRefusal(
      row.user_profile_id,
      'linked_organization_spend_limit_reached',
      connectedAt
    );
    await markClaudeBillingUnavailable(
      row.user_profile_id,
      'user_profile_not_billable',
      connectedAt
    );
    expect((await callback()).headers.get('location')).toContain('claude_billing=connected');
    expect(await state(row.id)).toMatchObject({
      status: 'connected',
      connection_id: 'ocon_new',
      last_refusal_code: null,
    });
  });

  it('does not undo a scope removal during approval when another scope shares the payer', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Claude shared concurrent remove', user.id, 0);
    const [payer] = await db
      .insert(claude_billing_connections)
      .values({
        kilo_user_id: user.id,
        user_profile_id: `uprof_${user.id}`,
        connection_id: 'ocon_shared',
        status: 'connected',
        connected_at: new Date().toISOString(),
        created_by: user.id,
      })
      .returning();
    if (!payer) throw new Error('Missing payer fixture');
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const member: ClaudeBillingOwner = {
      kind: 'member',
      kiloUserId: user.id,
      organizationId: org.id,
    };
    await shareClaudeBillingConnection(personal, member, user.id);
    signedIn(user);

    await connect(
      new NextRequest('http://localhost/claude/billing/connect?owner=personal&return=%2Fbyok')
    );
    const savedPending = jest.mocked(saveClaudeBillingPending).mock.calls[0]?.[0];
    if (!savedPending) throw new Error('Missing saved pending fixture');

    await removeClaudeBillingGrant(personal);
    jest.mocked(consumeClaudeBillingPending).mockResolvedValueOnce(savedPending);
    const response = await callback(`state=${savedPending.state}&code=one-use-code`);

    expect(response.headers.get('location')).toContain('claude_billing=failed');
    await expect(getGrantedClaudeBillingConnection(personal)).resolves.toBeNull();
    await expect(getGrantedClaudeBillingConnection(member)).resolves.toMatchObject({
      id: payer.id,
      status: 'connected',
    });
  });

  it('allocates a fresh profile for a second Claude account after removing a shared grant, keeping cancelled attempts inactive', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Claude second account', user.id, 0);
    const [payer] = await db
      .insert(claude_billing_connections)
      .values({
        kilo_user_id: user.id,
        user_profile_id: `uprof_${user.id}`,
        connection_id: 'ocon_shared',
        status: 'connected',
        connected_at: new Date().toISOString(),
        created_by: user.id,
      })
      .returning();
    if (!payer) throw new Error('Missing payer fixture');
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const member: ClaudeBillingOwner = {
      kind: 'member',
      kiloUserId: user.id,
      organizationId: org.id,
    };
    await shareClaudeBillingConnection(personal, member, user.id);
    await removeClaudeBillingGrant(personal);
    signedIn(user);

    await connect(
      new NextRequest('http://localhost/claude/billing/connect?owner=personal&return=%2Fbyok')
    );
    const savedPending = jest.mocked(saveClaudeBillingPending).mock.calls[0]?.[0];
    if (!savedPending) throw new Error('Missing saved pending fixture');
    expect(savedPending.userProfileId).not.toBe(payer.user_profile_id);

    jest.mocked(consumeClaudeBillingPending).mockResolvedValueOnce(savedPending);
    const declined = await callback(`state=${savedPending.state}&error=access_denied`);
    expect(declined.headers.get('location')).toContain('claude_billing=declined');
    await expect(getGrantedClaudeBillingConnection(personal)).resolves.toMatchObject({
      status: 'pending',
      connection_id: null,
    });

    jest.mocked(consumeClaudeBillingPending).mockResolvedValueOnce(savedPending);
    const approved = await callback(`state=${savedPending.state}&code=one-use-code`);
    expect(approved.headers.get('location')).toContain('claude_billing=connected');
    await expect(getGrantedClaudeBillingConnection(personal)).resolves.toMatchObject({
      user_profile_id: savedPending.userProfileId,
      status: 'connected',
      connection_id: 'ocon_new',
    });
    await expect(getGrantedClaudeBillingConnection(member)).resolves.toMatchObject({
      id: payer.id,
      user_profile_id: payer.user_profile_id,
      status: 'connected',
    });
  });

  it('starts only a shared-services link for an organization manager', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Claude connect', user.id, 0);
    signedIn(user);
    jest.mocked(consumeClaudeBillingPending).mockResolvedValue(null);

    await connect(
      new NextRequest(
        `http://localhost/claude/billing/connect?owner=${org.id}&scope=shared_services&return=%2Fbyok`
      )
    );
    const [row] = await db
      .select()
      .from(claude_billing_connections)
      .where(eq(claude_billing_connections.organization_id, org.id));
    expect(row).toMatchObject({ kilo_user_id: null, created_by: user.id, status: 'pending' });
  });

  it('starts a member link for an organization member', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Claude member', user.id, 0);
    signedIn(user);
    jest.mocked(consumeClaudeBillingPending).mockResolvedValue(null);

    await connect(
      new NextRequest(`http://localhost/claude/billing/connect?owner=${org.id}&return=%2Fbyok`)
    );
    const [row] = await db
      .select()
      .from(claude_billing_connections)
      .where(eq(claude_billing_connections.organization_id, org.id));
    expect(row).toMatchObject({ kilo_user_id: user.id, created_by: user.id, status: 'pending' });
  });

  it('refuses a shared-services link from a person who does not manage the organization', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Claude refused', user.id, 0);
    signedIn(user);
    jest.mocked(canManageClaudeBillingOrganization).mockResolvedValue(false);

    const response = await connect(
      new NextRequest(
        `http://localhost/claude/billing/connect?owner=${org.id}&scope=shared_services&return=%2Fbyok`
      )
    );
    expect(response.headers.get('location')).toContain('claude_billing_shared=forbidden');
    const rows = await db
      .select()
      .from(claude_billing_connections)
      .where(eq(claude_billing_connections.organization_id, org.id));
    expect(rows).toEqual([]);
  });
});

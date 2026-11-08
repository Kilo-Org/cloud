jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromSession: jest.fn() }));
jest.mock('./pending', () => ({ consumeClaudeBillingPending: jest.fn() }));
jest.mock('./access', () => ({
  canManageClaudeBillingOrganization: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/auth/claude/feature-flag.server', () => ({
  isClaudePlatformOAuthEnabled: jest.fn(async () => true),
}));
jest.mock('./protocol', () => ({
  exchangeClaudeBillingCode: jest.fn(),
  ClaudeBillingExchangeError: class extends Error {
    constructor(readonly oauthError: string) {
      super(oauthError);
    }
  },
}));
import { beforeEach, describe, expect, it } from '@jest/globals';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { claude_billing_connections, byok_api_keys } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { getUserFromSession } from '@kilocode/web-shared/lib/user/server';
import { consumeClaudeBillingPending } from './pending';
import { canManageClaudeBillingOrganization } from './access';
import { isClaudePlatformOAuthEnabled } from '@kilocode/web-shared/lib/auth/claude/feature-flag.server';
import { exchangeClaudeBillingCode, ClaudeBillingExchangeError } from './protocol';
import { GET } from '@/app/claude/billing/callback/route';
import { GET as connect } from '@/app/claude/billing/connect/route';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import {
  clearClaudeBillingRefusal,
  markClaudeBillingUnavailable,
  recordClaudeBillingRefusal,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';

beforeEach(() => {
  jest.mocked(isClaudePlatformOAuthEnabled).mockReset().mockResolvedValue(true);
  jest.mocked(canManageClaudeBillingOrganization).mockReset().mockResolvedValue(true);
  jest.mocked(exchangeClaudeBillingCode).mockReset().mockResolvedValue('ocon_new');
});

async function seed(organization = false) {
  const user = await insertTestUser();
  const org = organization ? await createTestOrganization('Claude callback', user.id, 0) : null;
  const [row] = await db
    .insert(claude_billing_connections)
    .values({
      kilo_user_id: org ? null : user.id,
      organization_id: org?.id ?? null,
      user_profile_id: `uprof_${user.id}`,
      created_by: user.id,
    })
    .returning();
  if (!row) throw new Error('Missing connection fixture');
  await db.insert(byok_api_keys).values({
    kilo_user_id: org ? null : user.id,
    organization_id: org?.id ?? null,
    provider_id: 'anthropic',
    encrypted_api_key: { encryptedData: 'fake' } as never,
    created_by: user.id,
  });
  jest.mocked(getUserFromSession).mockResolvedValue({ id: user.id });
  jest.mocked(consumeClaudeBillingPending).mockResolvedValue({
    kiloUserId: user.id,
    owner: org?.id ?? 'personal',
    returnPath: '/byok',
    state: 'expected',
    codeVerifier: 'verifier',
    userProfileId: row.user_profile_id,
    connectionVersion: row.updated_at,
  });
  return { user, row, org };
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

describe('Claude billing callback', () => {
  it.each([false, true])(
    'connects the authorized owner and deletes only its pasted key (org=%s)',
    async org => {
      const fixture = await seed(org);
      const response = await callback();
      expect(response.headers.get('location')).toContain('claude_billing=connected');
      expect(isClaudePlatformOAuthEnabled).toHaveBeenCalledWith(fixture.user.google_user_email);
      expect(await state(fixture.row.id)).toMatchObject({
        status: 'connected',
        connection_id: 'ocon_new',
      });
      const keys = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.created_by, fixture.user.id));
      expect(keys).toEqual([]);
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
    jest.mocked(getUserFromSession).mockResolvedValue({ id: 'another-user' });
    expect((await callback()).headers.get('location')).toContain('claude_billing=failed');
    expect(exchangeClaudeBillingCode).not.toHaveBeenCalled();
  });

  it('rechecks organization management after approval', async () => {
    const { row } = await seed(true);
    jest.mocked(canManageClaudeBillingOrganization).mockResolvedValue(false);
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
    'refuses %s when the session user has no database email',
    async flow => {
      const { row } = await seed();
      const missingUserId = 'missing-claude-billing-user';
      jest.mocked(getUserFromSession).mockResolvedValue({ id: missingUserId });
      const pending = await consumeClaudeBillingPending();
      if (!pending) throw new Error('Missing pending fixture');
      jest.mocked(consumeClaudeBillingPending).mockResolvedValue({
        ...pending,
        kiloUserId: missingUserId,
      });
      jest.mocked(isClaudePlatformOAuthEnabled).mockImplementation(async email => Boolean(email));

      const response =
        flow === 'connect'
          ? await connect(new NextRequest('http://localhost/claude/billing/connect'))
          : await callback();
      expect(response.headers.get('location')).toContain('claude_billing=forbidden');
      expect(isClaudePlatformOAuthEnabled).toHaveBeenCalledWith(undefined);
      expect(exchangeClaudeBillingCode).not.toHaveBeenCalled();
      expect(await state(row.id)).toMatchObject({ status: 'pending', connection_id: null });
    }
  );

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
    const keys = await db.select().from(byok_api_keys).where(eq(byok_api_keys.created_by, user.id));
    expect(keys.map(key => key.provider_id)).toEqual(['anthropic']);
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
});

jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromSession: jest.fn() }));
jest.mock('./pending', () => ({ consumeClaudeBillingPending: jest.fn() }));
jest.mock('./access', () => ({
  canManageClaudeBillingOrganization: jest.fn(),
  canUseClaudeBilling: jest.fn(),
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
import { canManageClaudeBillingOrganization, canUseClaudeBilling } from './access';
import { exchangeClaudeBillingCode, ClaudeBillingExchangeError } from './protocol';
import { GET } from '@/app/claude/billing/callback/route';

beforeEach(() => {
  jest.mocked(canUseClaudeBilling).mockReset().mockResolvedValue(true);
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
});

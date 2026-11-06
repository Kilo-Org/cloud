import { describe, expect, it } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { claude_billing_connections } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';
import {
  clearClaudeBillingRefusal,
  getClaudeBillingConnection,
  markClaudeBillingUnavailable,
  recordClaudeBillingRefusal,
} from './store';
import { claudeBillingRefusalCodeFor, isClaudeBillingConnectionDead } from './refusal';

describe('Claude billing refusal transitions', () => {
  it('records spend limits without disabling the connection and clears them after success', async () => {
    const user = await insertTestUser();
    const connectedAt = '2026-01-01T00:00:00Z';
    await db.insert(claude_billing_connections).values({
      kilo_user_id: user.id,
      user_profile_id: `uprof_${user.id}`,
      created_by: user.id,
      status: 'connected',
      connected_at: connectedAt,
    });
    await recordClaudeBillingRefusal(
      `uprof_${user.id}`,
      'linked_organization_spend_limit_reached',
      connectedAt
    );
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({
      status: 'connected',
      last_refusal_code: 'linked_organization_spend_limit_reached',
    });
    await clearClaudeBillingRefusal(`uprof_${user.id}`, connectedAt);
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({ status: 'connected', last_refusal_code: null });
  });

  it('does not let an old refusal disable a newly reconnected owner', async () => {
    const user = await insertTestUser();
    const profileId = `uprof_${user.id}`;
    await db.insert(claude_billing_connections).values({
      kilo_user_id: user.id,
      user_profile_id: profileId,
      created_by: user.id,
      status: 'connected',
      connected_at: '2026-02-01T00:00:00Z',
    });
    await markClaudeBillingUnavailable(
      profileId,
      'user_profile_not_billable',
      '2026-01-01T00:00:00Z'
    );
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({ status: 'connected', last_refusal_code: null });
    await markClaudeBillingUnavailable(
      profileId,
      'user_profile_not_billable',
      '2026-02-01T00:00:00Z'
    );
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({
      status: 'billing_unavailable',
      last_refusal_code: 'user_profile_not_billable',
    });
    await clearClaudeBillingRefusal(profileId, '2026-02-01T00:00:00Z');
    expect(
      await db
        .select()
        .from(claude_billing_connections)
        .where(eq(claude_billing_connections.user_profile_id, profileId))
    ).toEqual([
      expect.objectContaining({
        status: 'billing_unavailable',
        last_refusal_code: 'user_profile_not_billable',
      }),
    ]);
  });

  it.each([
    [403, { error: { message: 'model access denied' } }, 'permission_error', false],
    [
      403,
      { error: { type: 'invalid_request_error', code: 'permission_error' } },
      'permission_error',
      false,
    ],
    [
      403,
      { error: { type: 'permission_error', details: { error_code: 'user_profile_not_billable' } } },
      'user_profile_not_billable',
      true,
    ],
    [402, { error: { code: 'billing_error' } }, 'billing_error', false],
    [
      402,
      { error: { details: { error_code: 'linked_organization_spend_limit_reached' } } },
      'linked_organization_spend_limit_reached',
      false,
    ],
  ] as const)('handles a refusal over either API (%s)', (status, body, code, terminal) => {
    expect(claudeBillingRefusalCodeFor(status, body)).toBe(code);
    expect(isClaudeBillingConnectionDead(code)).toBe(terminal);
  });
});

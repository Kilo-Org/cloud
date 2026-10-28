import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { enkrypt_guardrail_charges } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';

describe('admin enkrypt guardrail charges router', () => {
  it('lists charges with organization and user details, and rejects non-admins', async () => {
    const admin = await insertTestUser({
      google_user_email: 'admin-enkrypt-charges@example.com',
      is_admin: true,
    });
    const user = await insertTestUser({
      google_user_email: 'user-enkrypt-charges@example.com',
      is_admin: false,
    });
    const organization = await createTestOrganization('Enkrypt Charges Org', user.id, 0);
    await db.insert(enkrypt_guardrail_charges).values([
      {
        organization_id: organization.id,
        kilo_user_id: user.id,
        api_kind: 'chat_completions',
        decision: 'allowed',
        enkrypt_credits_cost: 1.5,
        charged_microdollars: 150,
        added_latency_ms: 40,
        created_at: '2026-10-28 10:00:00+00',
      },
      {
        organization_id: organization.id,
        kilo_user_id: user.id,
        session_id: 'ses_test',
        api_kind: 'messages',
        decision: 'blocked',
        enkrypt_credits_cost: 2,
        charged_microdollars: 200,
        added_latency_ms: 60,
        created_at: '2026-10-28 11:00:00+00',
      },
    ]);

    await expect(
      (await createCallerForUser(user.id)).admin.enkryptGuardrailCharges.list({})
    ).rejects.toThrow('Admin access required');

    const result = await (
      await createCallerForUser(admin.id)
    ).admin.enkryptGuardrailCharges.list({ organizationId: organization.id });

    expect(result.rows.map(row => [row.decision, row.created_at])).toEqual([
      ['blocked', '2026-10-28T11:00:00.000Z'],
      ['allowed', '2026-10-28T10:00:00.000Z'],
    ]);
    expect(result.rows[0]).toMatchObject({
      organization_name: 'Enkrypt Charges Org',
      user_email: 'user-enkrypt-charges@example.com',
      session_id: 'ses_test',
    });
    expect(result.summary).toEqual({
      total_calls: 2,
      allowed: 1,
      blocked: 1,
      errors: 0,
      total_credits: 3.5,
      total_charged_microdollars: 350,
      avg_added_latency_ms: 50,
      organizations: 1,
    });
  });
});

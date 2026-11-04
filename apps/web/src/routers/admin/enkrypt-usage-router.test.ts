import { createCallerForUser } from '@/routers/test-utils';
import { provisionEnkryptUsagePartitions } from '@/lib/usage-partitions';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  api_kind,
  enkrypt_usage,
  enkrypt_usage_decision,
  enkrypt_usage_guardrail,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

describe('admin enkrypt usage router', () => {
  it('lists the last 30 days of usage records with organization and user details, and rejects non-admins', async () => {
    const admin = await insertTestUser({
      google_user_email: 'admin-enkrypt-usage@example.com',
      is_admin: true,
    });
    const user = await insertTestUser({
      google_user_email: 'user-enkrypt-usage@example.com',
      is_admin: false,
    });
    const organization = await createTestOrganization('Enkrypt Usage Org', user.id, 0);
    const allowedAt = hoursAgo(2);
    const blockedAt = hoursAgo(1);
    const errorAt = hoursAgo(0.5);
    const outputAt = hoursAgo(0.25);
    const expiredAt = hoursAgo(31 * 24);
    const partitions = await provisionEnkryptUsagePartitions(db, new Date(expiredAt));
    expect(partitions.errors).toEqual([]);
    const apiKinds = await db
      .insert(api_kind)
      .values([
        { api_kind: 'chat_completions' },
        { api_kind: 'messages' },
        { api_kind: 'responses' },
      ])
      .onConflictDoUpdate({ target: api_kind.api_kind, set: { api_kind: api_kind.api_kind } })
      .returning();
    const decisions = await db
      .insert(enkrypt_usage_decision)
      .values([{ decision: 'allowed' }, { decision: 'blocked' }, { decision: 'error' }])
      .onConflictDoUpdate({
        target: enkrypt_usage_decision.decision,
        set: { decision: enkrypt_usage_decision.decision },
      })
      .returning();
    const [outputGuardrail] = await db
      .insert(enkrypt_usage_guardrail)
      .values({ guardrail: 'output' })
      .onConflictDoUpdate({
        target: enkrypt_usage_guardrail.guardrail,
        set: { guardrail: enkrypt_usage_guardrail.guardrail },
      })
      .returning();
    const apiKindId = (value: string) => {
      const row = apiKinds.find(row => row.api_kind === value);
      if (!row) throw new Error(`Missing test API kind: ${value}`);
      return row.api_kind_id;
    };
    const decisionId = (value: string) => {
      const row = decisions.find(row => row.decision === value);
      if (!row) throw new Error(`Missing test decision: ${value}`);
      return row.decision_id;
    };
    await db.insert(enkrypt_usage).values([
      {
        organization_id: organization.id,
        kilo_user_id: user.id,
        api_kind_id: apiKindId('chat_completions'),
        decision_id: decisionId('allowed'),
        enkrypt_credits_cost: 1.5,
        charged_microdollars: 150,
        added_latency_ms: 40,
        created_at: allowedAt,
      },
      {
        organization_id: organization.id,
        kilo_user_id: user.id,
        session_id: 'ses_test',
        api_kind_id: apiKindId('messages'),
        decision_id: decisionId('blocked'),
        enkrypt_credits_cost: 2,
        charged_microdollars: 200,
        added_latency_ms: 60,
        created_at: blockedAt,
      },
      {
        organization_id: organization.id,
        kilo_user_id: user.id,
        api_kind_id: apiKindId('messages'),
        decision_id: decisionId('allowed'),
        enkrypt_credits_cost: 1,
        charged_microdollars: 100,
        added_latency_ms: 900,
        guardrail_id: outputGuardrail.guardrail_id,
        created_at: outputAt,
      },
      {
        organization_id: organization.id,
        kilo_user_id: user.id,
        api_kind_id: apiKindId('responses'),
        decision_id: decisionId('error'),
        charged_microdollars: 0,
        created_at: errorAt,
      },
      {
        organization_id: organization.id,
        kilo_user_id: user.id,
        api_kind_id: apiKindId('responses'),
        decision_id: decisionId('error'),
        charged_microdollars: 0,
        created_at: expiredAt,
      },
    ]);

    await expect((await createCallerForUser(user.id)).admin.enkryptUsage.list({})).rejects.toThrow(
      'Admin access required'
    );

    const result = await (
      await createCallerForUser(admin.id)
    ).admin.enkryptUsage.list({ organizationId: organization.id });

    expect(
      result.rows.map(row => [row.api_kind, row.decision, row.guardrail, row.created_at])
    ).toEqual([
      ['messages', 'allowed', 'output', outputAt],
      ['responses', 'error', 'input', errorAt],
      ['messages', 'blocked', 'input', blockedAt],
      ['chat_completions', 'allowed', 'input', allowedAt],
    ]);
    expect(result.rows[2]).toMatchObject({
      organization_name: 'Enkrypt Usage Org',
      user_email: 'user-enkrypt-usage@example.com',
      session_id: 'ses_test',
      api_kind: 'messages',
    });
    expect(result.summary).toEqual({
      total_calls: 4,
      allowed: 2,
      blocked: 1,
      errors: 1,
      total_credits: 4.5,
      total_charged_microdollars: 450,
      avg_added_latency_ms: 50,
      avg_output_added_latency_ms: 900,
      organizations: 1,
    });

    const limited = await (
      await createCallerForUser(admin.id)
    ).admin.enkryptUsage.list({ organizationId: organization.id, limit: 1 });
    expect(limited.rows).toHaveLength(1);
    expect(limited.rows[0]).toEqual(result.rows[0]);
    expect(limited.summary).toEqual(result.summary);
  });
});

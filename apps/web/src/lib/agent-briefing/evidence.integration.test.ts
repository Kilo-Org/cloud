import { eq, sql } from 'drizzle-orm';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_context_preferences,
  agent_briefing_preferences,
  agent_briefing_snapshots,
  cli_sessions_v2,
  microdollar_usage,
  microdollar_usage_metadata,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { dispatchAgentBriefingPush } from '@kilocode/web-shared/lib/notifications-worker-client';
import {
  briefingChargeAccountingSchema,
  recordBriefingUsage,
} from '@kilocode/web-shared/lib/agent-briefing-usage';
import type { UsageAccountingResult } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { getBalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { sweepAgentBriefings, generatePendingAgentBriefings } from './sweep';
import { reconcileBriefingCharge, runBriefingSummary, SUMMARY_MAX_ATTEMPTS } from './summary';
import { briefingFactsSchema, buildBriefingSnapshot, collectBriefingSnapshot } from './evidence';
import { agentBriefingRouter } from '@/routers/agent-briefing-router';
import { emptySummary } from './store';

jest.mock('@kilocode/web-shared/lib/notifications-worker-client', () => ({
  dispatchAgentBriefingPush: jest.fn().mockResolvedValue(false),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModelsMetadataFromDatabase: jest.fn().mockResolvedValue({}),
  getVercelModelsMetadataFromDatabase: jest.fn().mockResolvedValue({}),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/unavailable-models', () => ({
  getUnavailableModelIds: jest.fn().mockResolvedValue(new Set()),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order-config', () => ({
  getPreferredProviderOrderConfig: jest.fn().mockResolvedValue({ rules: [] }),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-pricing-config', () => ({
  getCustomPricingConfig: jest.fn().mockResolvedValue({ models: [] }),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organization-usage', () => ({
  getBalanceAndOrgSettings: jest.fn().mockResolvedValue({ payer: {}, balance: 10 }),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/ai-gateway/providers/openrouter'),
  getRawOpenRouterModels: jest.fn().mockResolvedValue({
    data: [
      {
        id: 'test/snapshot',
        name: 'Snapshot test model',
        created: 0,
        description: '',
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['text'],
          tokenizer: 'Other',
        },
        top_provider: { is_moderated: false },
        pricing: { prompt: '0.000001', completion: '0.000002' },
        context_length: 128000,
      },
    ],
  }),
}));
beforeEach(cleanupDbForTest);
afterEach(() => jest.restoreAllMocks());
async function scheduled(active = true) {
  const user = await insertTestUser({ total_microdollars_acquired: 10_000_000 });
  const now = new Date();
  const clock = (date: Date) => date.toISOString().slice(11, 16);
  const morning = new Date(now.getTime() - 5 * 60_000);
  morning.setUTCSeconds(0, 0);
  await db.insert(agent_briefing_preferences).values({
    kilo_user_id: user.id,
    timezone: 'UTC',
    night_start: clock(new Date(morning.getTime() - 3 * 3600_000)),
    morning_start: clock(morning),
    morning_end: clock(new Date(morning.getTime() + 3 * 3600_000)),
    next_run_at: morning.toISOString(),
  });
  await db.insert(agent_briefing_context_preferences).values({
    kilo_user_id: user.id,
    context_key: 'personal',
    enabled: true,
    model: 'test/snapshot',
  });
  if (active)
    await db.insert(cli_sessions_v2).values({
      session_id: `ses_${crypto.randomUUID()}`,
      kilo_user_id: user.id,
      title: 'Captured session',
      last_activity_at: new Date(morning.getTime() - 3600_000).toISOString(),
      briefing_excerpt: {
        messageId: 'completed',
        completedAt: new Date(morning.getTime() - 3600_000).toISOString(),
        text: 'Completed final response',
      },
    });
  return { user, now };
}
async function recordBilledAttempt(reportId: string) {
  const [report] = await db
    .select()
    .from(agent_briefing_snapshots)
    .where(eq(agent_briefing_snapshots.id, reportId));
  if (!report?.generation_id) throw new Error('No generation');
  const generation = briefingChargeAccountingSchema
    .parse(report.summary.chargeAccounting)
    .generations.find(entry => entry.id === report.generation_id);
  if (!generation?.settlementToken) throw new Error('No settlement token');
  await recordBriefingUsage({
    kiloUserId: report.kilo_user_id,
    generationId: report.generation_id,
    settlementToken: generation.settlementToken,
    usage: {
      status: 'queued',
      usageId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    },
  });
}
it('atomically captures one occurrence only for explicitly enabled contexts', async () => {
  const { user, now } = await scheduled();
  const org = await createTestOrganization('Disabled context', user.id, 0);
  await db.insert(cli_sessions_v2).values({
    session_id: 'ses_org',
    kilo_user_id: user.id,
    organization_id: org.id,
    last_activity_at: now.toISOString(),
  });
  await Promise.all([sweepAgentBriefings(now), sweepAgentBriefings(now)]);
  const rows = await db.select().from(agent_briefing_snapshots);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.context_key).toBe('personal');
  expect(rows[0]?.facts.scorecard).toEqual({ sessions: 1, pullRequests: 0, blockers: 0 });
  await sweepAgentBriefings(new Date(now.getTime() + 60_000));
  expect(await db.select().from(agent_briefing_snapshots)).toHaveLength(1);
});
it('publishes a quiet structured snapshot without any model call', async () => {
  const { now } = await scheduled(false);
  const fetcher = jest.spyOn(globalThis, 'fetch');
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  expect(row?.published_at).not.toBeNull();
  expect(row?.summary.status).toBe('unavailable');
  expect(row?.job_due_at).toBeNull();
  await generatePendingAgentBriefings();
  expect(fetcher).not.toHaveBeenCalled();
});
it('claims paid generation once across simultaneous workers and never refreshes its input', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      Response.json({ choices: [{ message: { content: 'Captured final response summarized.' } }] })
    );
  await Promise.all([runBriefingSummary(row.id), runBriefingSummary(row.id)]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [finished] = await db.select().from(agent_briefing_snapshots);
  expect(finished?.summary.status).toBe('ready');
  expect(finished?.facts).toEqual(row.facts);
  await runBriefingSummary(row.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('sends screened evidence to the model provider', async () => {
  const { user, now } = await scheduled();
  const secret = 'wJalrXUtnFEMI/' + 'K7MDENG/bPxRfiCYEXAMPLEKEY';
  const escaped = 'abc' + '\\"def' + 'SECRET';
  const nested = 'hunter' + '2';
  const shellJson = 'nested' + '9';
  const punctuated = 'p@ss' + '?Quokka';
  const alias = 'hunter' + '9';
  const joined = 'hunter' + '7';
  await db
    .update(cli_sessions_v2)
    .set({
      title: 'Sweep for client_' + 'secret: "' + secret,
      briefing_excerpt: {
        messageId: 'completed',
        completedAt: new Date(now.getTime() - 3600_000).toISOString(),
        text:
          'Deploy ran with AWS_SECRET_' +
          `ACCESS_KEY=${secret} in the shell. Config {"password":"${escaped}"} and ` +
          `flags user=bob&password=${nested}. Hook: curl -d "{\\"password\\":\\"${shellJson}\\"}". ` +
          `Rotated with password=${punctuated} before the run. ` +
          'Shell env MYSQL_' +
          `PWD=${alias} and DB_` +
          `PASS=${alias}. Keychain PASS` +
          `KEY=${joined}, pg` +
          `pass=${joined}, mongo` +
          `pass=${joined}, oracle` +
          `pass=${joined}.`,
      },
    })
    .where(eq(cli_sessions_v2.kilo_user_id, user.id));
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  expect(JSON.stringify(row.facts)).not.toContain(secret);
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ choices: [{ message: { content: 'Summary' } }] }));
  await runBriefingSummary(row.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const posted = fetcher.mock.calls[0];
  const body = JSON.parse(String(posted?.[1]?.body)) as {
    messages: Array<{ content: string }>;
  };
  const prompt = body.messages.map(message => message.content).join('\n');
  expect(prompt).not.toContain(secret);
  expect(prompt).not.toContain('def' + 'SECRET');
  expect(prompt).not.toContain(nested);
  expect(prompt).not.toContain(shellJson);
  expect(prompt).not.toContain('Quokka');
  expect(prompt).not.toContain(alias);
  expect(prompt).not.toContain(joined);
  expect(prompt).not.toContain('Agent session');
  expect(prompt).toContain('[redacted credential]');
});

it('publishes failure while preserving facts and refuses automatic paid retries', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const fetcher = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
  await runBriefingSummary(row.id);
  await generatePendingAgentBriefings();
  const [failed] = await db.select().from(agent_briefing_snapshots);
  expect(failed?.summary.status).toBe('failed');
  expect(failed?.published_at).not.toBeNull();
  expect(failed?.facts).toEqual(row.facts);
  expect(fetcher).toHaveBeenCalledTimes(SUMMARY_MAX_ATTEMPTS);
}, 20_000);

it('retries a transient gateway decline and publishes the answer it gets', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('{}', { status: 429 }))
    .mockResolvedValueOnce(
      Response.json({ choices: [{ message: { content: 'Retried morning summary.' } }] })
    );
  await runBriefingSummary(row.id);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const [first] = fetcher.mock.calls;
  const [second] = fetcher.mock.calls.slice(1);
  expect(new Headers(second?.[1]?.headers).get('x-kilo-session')).toBe(
    new Headers(first?.[1]?.headers).get('x-kilo-session')
  );
  const [finished] = await db.select().from(agent_briefing_snapshots);
  expect(finished?.summary.status).toBe('ready');
  expect(finished?.summary.text).toBe('Retried morning summary.');
}, 20_000);

it('does not repeat an attempt the gateway already billed', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    // A lost response: the gateway billed the answer and recorded its usage
    // identifier, then the caller's connection failed. A repeat would pay twice.
    .mockImplementationOnce(async () => {
      await recordBilledAttempt(row.id);
      throw new TypeError('fetch failed');
    })
    .mockResolvedValue(Response.json({ choices: [{ message: { content: 'Unbilled repeat.' } }] }));
  await runBriefingSummary(row.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [failed] = await db.select().from(agent_briefing_snapshots);
  expect(failed?.summary.status).toBe('failed');
  expect(failed?.summary.error).toBe('generation_failed');
}, 20_000);

it('does not repeat while the generation accounting is unreadable', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementationOnce(async () => {
      await db
        .update(agent_briefing_snapshots)
        .set({
          summary: sql`${agent_briefing_snapshots.summary} || ${JSON.stringify({ chargeAccounting: { unreadable: true } })}::jsonb`,
        })
        .where(eq(agent_briefing_snapshots.id, row.id));
      throw new TypeError('fetch failed');
    })
    .mockResolvedValue(Response.json({ choices: [{ message: { content: 'Unbilled repeat.' } }] }));
  await runBriefingSummary(row.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [failed] = await db.select().from(agent_briefing_snapshots);
  expect(failed?.summary.status).toBe('failed');
}, 20_000);

it('fails a terminal decline without a second request', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{}', { status: 400 }));
  await runBriefingSummary(row.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [failed] = await db.select().from(agent_briefing_snapshots);
  expect(failed?.summary.status).toBe('failed');
  expect(failed?.summary.error).toBe('gateway_declined');
});

// A transient admission failure leaves the row pending; the retry budget has
// pushed its due time out, and the next due run succeeds and generates it.
it('retries a row whose admission hit a transient failure and later generates it', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const balance = jest.mocked(getBalanceAndOrgSettings);
  balance.mockRejectedValueOnce(new Error('_transient'));
  const fetcher = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
  await expect(runBriefingSummary(row.id)).rejects.toThrow('_transient');
  expect(fetcher).not.toHaveBeenCalled();
  const [stalled] = await db.select().from(agent_briefing_snapshots);
  expect(stalled?.summary.status).toBe('pending');
  expect(stalled?.generation_id).toBeNull();
  expect(Date.parse(stalled?.job_due_at ?? '')).toBeGreaterThan(Date.parse(row.job_due_at ?? ''));
  fetcher.mockResolvedValue(
    Response.json({ choices: [{ message: { content: 'Recovered summary.' } }] })
  );
  await runBriefingSummary(row.id);
  const [finished] = await db.select().from(agent_briefing_snapshots);
  expect(finished?.summary.status).toBe('ready');
  expect(finished?.summary.text).toBe('Recovered summary.');
});

// A captured source row that is deleted afterwards is a deterministic refusal of
// the stored snapshot: the mapped code is recorded without holding a slot, and
// the row does not stay due to be selected ahead of newer reports every tick.
it('records a failed refusal when a captured source row is gone', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const facts = briefingFactsSchema.parse(row.facts);
  const sourceIds = facts.sessions.flatMap(session =>
    session.sources.map(source => source.sessionId)
  );
  await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sourceIds[0]!));
  const fetcher = jest.spyOn(globalThis, 'fetch');
  await runBriefingSummary(row.id);
  const [refused] = await db.select().from(agent_briefing_snapshots);
  expect(refused?.summary.status).toBe('failed');
  expect(refused?.summary.error).toBe('permission_unavailable');
  expect(refused?.generation_id).toBeNull();
  expect(refused?.job_due_at).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

// A lookup that stays down while the row is due must not keep a selection slot:
// each rejection is retried on a later due run, and the budget then records the
// cause instead of rethrowing.
it('records the mapped refusal after the admission rethrow budget', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const balance = jest.mocked(getBalanceAndOrgSettings);
  // One-shot rejections: one for each rethrow under the budget and one for the
  // call that records the refusal, leaving the module default for later tests.
  balance
    .mockRejectedValueOnce(new Error('_persistent'))
    .mockRejectedValueOnce(new Error('_persistent'))
    .mockRejectedValueOnce(new Error('_persistent'))
    .mockRejectedValueOnce(new Error('_persistent'));
  const fetcher = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
  const dueAt = row.job_due_at;
  if (!dueAt) throw new Error('No due time');
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(runBriefingSummary(row.id)).rejects.toThrow('_persistent');
    const [pending] = await db.select().from(agent_briefing_snapshots);
    expect(pending?.summary.status).toBe('pending');
    expect(pending?.generation_id).toBeNull();
    if (attempt === 0) {
      expect(Date.parse(pending?.job_due_at ?? '')).toBeGreaterThan(Date.parse(dueAt));
      await db
        .update(agent_briefing_snapshots)
        .set({ job_due_at: dueAt })
        .where(eq(agent_briefing_snapshots.id, row.id));
    }
  }
  await runBriefingSummary(row.id);
  const [refused] = await db.select().from(agent_briefing_snapshots);
  expect(refused?.summary.status).toBe('failed');
  expect(refused?.summary.error).toBe('generation_failed');
  expect(refused?.generation_id).toBeNull();
  expect(refused?.summary.admissionAttempts).toBe(3);
  expect(fetcher).not.toHaveBeenCalled();
});

it('does not repeat a successful answer whose body cannot be read', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError('terminated'));
        },
      }),
      { status: 200 }
    )
  );
  await runBriefingSummary(row.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [failed] = await db.select().from(agent_briefing_snapshots);
  expect(failed?.summary.status).toBe('failed');
  expect(failed?.summary.error).toBe('generation_failed');
});

it('records a provider answer that does not match the response shape as a generation failure', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ error: { message: 'provider envelope' } }));
  await runBriefingSummary(row.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [failed] = await db.select().from(agent_briefing_snapshots);
  expect(failed?.summary.status).toBe('failed');
  expect(failed?.summary.error).toBe('generation_failed');
});

it('does not repeat a decline the gateway answers after an accounted generation', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    // The shape the gateway sends when a guardrail replaces an answer: a decline
    // that asks for a quick repeat and carries no `x-should-retry` verdict of its
    // own, alongside the marker that the answer was already accounted.
    new Response('{}', {
      status: 503,
      headers: { 'retry-after': '1', 'x-kilo-replaced-answer': 'true' },
    })
  );
  await runBriefingSummary(row.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [failed] = await db.select().from(agent_briefing_snapshots);
  expect(failed?.summary.status).toBe('failed');
});

it('does not repeat a rate limit the gateway marks final', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{}', { status: 429, headers: { 'x-should-retry': 'false' } }));
  await runBriefingSummary(row.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [failed] = await db.select().from(agent_briefing_snapshots);
  expect(failed?.summary.status).toBe('failed');
});

it('does not wait past the generation deadline for a retry', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{}', { status: 503, headers: { 'retry-after': '900' } }));
  await runBriefingSummary(row.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [failed] = await db.select().from(agent_briefing_snapshots);
  expect(failed?.summary.status).toBe('failed');
});

it('retries an aborted request and records the failure at the bound', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new DOMException('The operation was aborted.', 'TimeoutError'));
  await runBriefingSummary(row.id);
  expect(fetcher).toHaveBeenCalledTimes(SUMMARY_MAX_ATTEMPTS);
  const [failed] = await db.select().from(agent_briefing_snapshots);
  expect(failed?.summary.status).toBe('failed');
  expect(failed?.summary.error).toBe('time_limit');
}, 20_000);
it('settles a delayed usage delivery against its immutable occurrence generation', async () => {
  const { now, user } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ choices: [{ message: { content: 'Summary' } }] }));
  await runBriefingSummary(row.id);
  const [generated] = await db.select().from(agent_briefing_snapshots);
  if (!generated?.generation_id) throw new Error('No generation');
  const usageId = crypto.randomUUID();
  await db.insert(microdollar_usage).values({
    id: usageId,
    kilo_user_id: user.id,
    cost: 42,
    input_tokens: 10,
    output_tokens: 5,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
  });
  await db
    .insert(microdollar_usage_metadata)
    .values({ id: usageId, session_id: generated.generation_id, message_id: 'summary-response' });
  await db
    .update(agent_briefing_snapshots)
    .set({
      summary: {
        ...generated.summary,
        chargeAccounting: {
          baselineCostMicrodollars: 0,
          generations: [{ id: generated.generation_id, usageId }],
        },
      },
    })
    .where(eq(agent_briefing_snapshots.id, row.id));
  const [receipt] = await db.select().from(agent_briefing_snapshots);
  if (!receipt) throw new Error('No receipt');
  const settled = await reconcileBriefingCharge(receipt);
  expect(settled.summary.costMicrodollars).toBe(42);
  expect(settled.summary.chargeStatus).toBe('settled');
  expect(settled.next_charge_check_at).toBeNull();
});

describe('briefing charge reconciliation for retried generations', () => {
  async function generated() {
    const { now, user } = await scheduled();
    await sweepAgentBriefings(now);
    const [row] = await db.select().from(agent_briefing_snapshots);
    if (!row) throw new Error('No captured snapshot');
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ choices: [{ message: { content: 'Summary' } }] }));
    await runBriefingSummary(row.id);
    const [report] = await db.select().from(agent_briefing_snapshots);
    if (!report?.generation_id) throw new Error('No generation');
    const generation = briefingChargeAccountingSchema
      .parse(report.summary.chargeAccounting)
      .generations.find(entry => entry.id === report.generation_id);
    if (!generation?.settlementToken) throw new Error('No settlement token');
    return {
      user,
      reportId: report.id,
      generationId: report.generation_id,
      settlementToken: generation.settlementToken,
    };
  }

  async function current(reportId: string) {
    const [row] = await db
      .select()
      .from(agent_briefing_snapshots)
      .where(eq(agent_briefing_snapshots.id, reportId));
    if (!row) throw new Error('No report');
    return row;
  }

  async function addUsageRow(generationId: string, userId: string, cost: number, usageId: string) {
    await db.insert(microdollar_usage).values({
      id: usageId,
      kilo_user_id: userId,
      cost,
      input_tokens: 10,
      output_tokens: 5,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
    });
    await db
      .insert(microdollar_usage_metadata)
      .values({ id: usageId, session_id: generationId, message_id: usageId });
  }

  async function record(
    prepared: Awaited<ReturnType<typeof generated>>,
    usageId: string,
    status: UsageAccountingResult['status'] = 'recorded'
  ) {
    await recordBriefingUsage({
      kiloUserId: prepared.user.id,
      generationId: prepared.generationId,
      settlementToken: prepared.settlementToken,
      usage: { status, usageId, createdAt: new Date().toISOString() },
    });
  }

  async function reconcile(reportId: string) {
    return reconcileBriefingCharge(await current(reportId));
  }

  function entries(row: Awaited<ReturnType<typeof current>>, generationId: string) {
    return briefingChargeAccountingSchema
      .parse(row.summary.chargeAccounting)
      .generations.filter(entry => entry.id === generationId);
  }

  function receiptIds(row: Awaited<ReturnType<typeof current>>, generationId: string) {
    return entries(row, generationId).map(entry => entry.usageId);
  }

  it('admits one empty receipt placeholder for a generation', async () => {
    const prepared = await generated();
    const admitted = await current(prepared.reportId);
    expect(entries(admitted, prepared.generationId)).toEqual([
      {
        id: prepared.generationId,
        settlementToken: prepared.settlementToken,
        usageId: null,
        deadlineAt: expect.any(String),
      },
    ]);
  });
  it('keeps a staggered two-attempt generation pending until the queued row lands', async () => {
    const prepared = await generated();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    await addUsageRow(prepared.generationId, prepared.user.id, 30, firstId);
    await record(prepared, firstId);
    await record(prepared, secondId, 'queued');
    const recorded = await current(prepared.reportId);
    expect(entries(recorded, prepared.generationId)).toMatchObject([
      { usageId: firstId, delivery: 'committed', deadlineAt: expect.any(String) },
      { usageId: secondId, delivery: 'queued', deadlineAt: expect.any(String) },
    ]);
    expect(entries(recorded, prepared.generationId)[1]?.deadlineAt).toBe(
      entries(recorded, prepared.generationId)[0]?.deadlineAt
    );
    const pending = await reconcile(prepared.reportId);
    expect(pending.summary.costMicrodollars).toBe(30);
    expect(pending.summary.chargeStatus).toBe('pending');
    expect(pending.next_charge_check_at).not.toBeNull();
    expect(receiptIds(pending, prepared.generationId)).toEqual([firstId, secondId]);
    await addUsageRow(prepared.generationId, prepared.user.id, 12, secondId);
    const settled = await reconcile(prepared.reportId);
    expect(settled.summary.costMicrodollars).toBe(42);
    expect(settled.summary.chargeStatus).toBe('settled');
    expect(settled.next_charge_check_at).toBeNull();
    expect(receiptIds(settled, prepared.generationId)).toEqual([firstId, secondId]);
  });

  it('settles a receipt that arrives after an earlier settlement', async () => {
    const prepared = await generated();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    await addUsageRow(prepared.generationId, prepared.user.id, 30, firstId);
    await record(prepared, firstId);
    const settled = await reconcile(prepared.reportId);
    expect(settled.summary.costMicrodollars).toBe(30);
    expect(settled.summary.chargeStatus).toBe('settled');
    expect(settled.next_charge_check_at).toBeNull();
    await addUsageRow(prepared.generationId, prepared.user.id, 12, secondId);
    await record(prepared, secondId);
    const rearmed = await current(prepared.reportId);
    expect(rearmed.summary.chargeStatus).toBe('pending');
    expect(rearmed.next_charge_check_at).not.toBeNull();
    const resettled = await reconcile(prepared.reportId);
    expect(resettled.summary.costMicrodollars).toBe(42);
    expect(resettled.summary.chargeStatus).toBe('settled');
    expect(resettled.next_charge_check_at).toBeNull();
  });

  it('sums receipts delivered in reverse attempt order', async () => {
    const prepared = await generated();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    await addUsageRow(prepared.generationId, prepared.user.id, 12, secondId);
    await record(prepared, secondId);
    await addUsageRow(prepared.generationId, prepared.user.id, 30, firstId);
    await record(prepared, firstId);
    const settled = await reconcile(prepared.reportId);
    expect(settled.summary.costMicrodollars).toBe(42);
    expect(settled.summary.chargeStatus).toBe('settled');
    expect(receiptIds(settled, prepared.generationId)).toEqual([secondId, firstId]);
  });

  it('counts a duplicate receipt once and does not re-arm after settlement', async () => {
    const prepared = await generated();
    const usageId = crypto.randomUUID();
    await addUsageRow(prepared.generationId, prepared.user.id, 30, usageId);
    await record(prepared, usageId);
    await record(prepared, usageId);
    const settled = await reconcile(prepared.reportId);
    expect(settled.summary.costMicrodollars).toBe(30);
    expect(receiptIds(settled, prepared.generationId)).toEqual([usageId]);
    expect(entries(settled, prepared.generationId)).toMatchObject([
      { usageId, delivery: 'committed', deliveryAt: expect.any(String) },
    ]);
    await record(prepared, usageId);
    const persisted = await current(prepared.reportId);
    expect(persisted.summary.chargeStatus).toBe('settled');
    expect(persisted.next_charge_check_at).toBeNull();
    expect(receiptIds(persisted, prepared.generationId)).toEqual([usageId]);
  });

  it('finalizes a missing queued receipt after its delivery window closes', async () => {
    const prepared = await generated();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    await addUsageRow(prepared.generationId, prepared.user.id, 30, firstId);
    await record(prepared, firstId);
    await record(prepared, secondId, 'queued');
    const pending = await reconcile(prepared.reportId);
    expect(pending.summary.chargeStatus).toBe('pending');
    const accounting = briefingChargeAccountingSchema.parse(pending.summary.chargeAccounting);
    const expiredDeliveryAt = new Date(Date.now() - 15 * 86_400_000).toISOString();
    const expiredAccounting = {
      ...accounting,
      generations: accounting.generations.map(generation =>
        generation.usageId === secondId
          ? { ...generation, deliveryAt: expiredDeliveryAt }
          : generation
      ),
    };
    await db
      .update(agent_briefing_snapshots)
      .set({
        summary: {
          ...pending.summary,
          chargeAccounting: expiredAccounting,
        },
      })
      .where(eq(agent_briefing_snapshots.id, prepared.reportId));
    const expired = await current(prepared.reportId);
    expect(entries(expired, prepared.generationId)).toMatchObject([
      { usageId: firstId },
      { usageId: secondId, delivery: 'queued', deliveryAt: expiredDeliveryAt },
    ]);
    const settled = await reconcile(prepared.reportId);
    expect(settled.summary.costMicrodollars).toBe(30);
    expect(settled.summary.chargeStatus).toBe('settled');
    expect(settled.next_charge_check_at).toBeNull();
    expect(receiptIds(settled, prepared.generationId)).toEqual([firstId, secondId]);
  });
});
it('selects latest activity deterministically and keeps organization scope exact', async () => {
  const { user, now } = await scheduled(false);
  const org = await createTestOrganization('Other context', user.id, 0);
  const activity = now.toISOString();
  await db.insert(cli_sessions_v2).values([
    { session_id: 'ses_b', kilo_user_id: user.id, last_activity_at: activity },
    { session_id: 'ses_a', kilo_user_id: user.id, last_activity_at: activity },
    {
      session_id: 'ses_other',
      kilo_user_id: user.id,
      organization_id: org.id,
      last_activity_at: activity,
    },
  ]);
  const facts = await collectBriefingSnapshot(
    user.id,
    null,
    new Date(now.getTime() - 86400_000).toISOString(),
    activity
  );
  expect(facts.sessions.map(session => session.sessionId)).toEqual(['ses_a', 'ses_b']);
});
it('deletes snapshots after bounded retention', async () => {
  const { user, now } = await scheduled(false);
  await sweepAgentBriefings(now);
  await db
    .update(agent_briefing_snapshots)
    .set({ expires_at: new Date(now.getTime() - 1).toISOString() })
    .where(eq(agent_briefing_snapshots.kilo_user_id, user.id));
  await sweepAgentBriefings(now);
  expect(await db.select().from(agent_briefing_snapshots)).toHaveLength(0);
});

it('limits paid model requests across overlapping scheduler invocations', async () => {
  const first = await scheduled();
  await scheduled();
  await scheduled();
  await sweepAgentBriefings(first.now);
  const rows = await db.select().from(agent_briefing_snapshots);
  const { promise: responseGate, resolve: release } = Promise.withResolvers<void>();
  const { promise: twoStarted, resolve: started } = Promise.withResolvers<void>();
  let requests = 0;
  const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    requests += 1;
    if (requests === 2) started();
    await responseGate;
    return Response.json({ choices: [{ message: { content: 'Summary' } }] });
  });
  const runs = rows.map(row => runBriefingSummary(row.id));
  try {
    await twoStarted;
    const statuses = await db.select().from(agent_briefing_snapshots);
    expect(statuses.filter(row => row.summary.status === 'running')).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await Promise.all(runs);
  }
  expect(
    (await db.select().from(agent_briefing_snapshots)).filter(
      row => row.summary.status === 'pending'
    )
  ).toHaveLength(1);
});

it('preserves saved snapshot readability while disabling future paid generation', async () => {
  const { now, user } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const caller = agentBriefingRouter.createCaller({ user });
  await caller.updateContextPreferences({ enabled: false });
  const saved = await caller.get({ reportId: row.id });
  expect(saved.sessions[0]?.title).toBe('Captured session');
  expect(saved.sources.some(source => source.excerpt === 'Completed final response')).toBe(true);
  const fetcher = jest.spyOn(globalThis, 'fetch');
  await runBriefingSummary(row.id);
  expect(fetcher).not.toHaveBeenCalled();
  const [failed] = await db.select().from(agent_briefing_snapshots);
  expect(failed?.summary.error).toBe('permission_unavailable');
  expect(failed?.summary.costMicrodollars).toBe(0);
  expect(failed?.facts).toEqual(row.facts);
  expect((await caller.get({ reportId: row.id })).summary.error).toBe('permission_unavailable');
});

it('fails rows their disabled context refuses without holding a generation slot', async () => {
  // A refusal must be recorded without claiming a generation slot, so the due row
  // behind it is still admitted in the same run.
  const first = await scheduled();
  const second = await scheduled();
  const third = await scheduled();
  await sweepAgentBriefings(first.now);
  const rows = await db.select().from(agent_briefing_snapshots);
  expect(rows).toHaveLength(3);
  const [refusedFirst, refusedSecond] = [first.user.id, second.user.id].map(userId =>
    rows.find(row => row.kilo_user_id === userId)
  );
  const valid = rows.find(row => row.kilo_user_id === third.user.id);
  if (!refusedFirst || !refusedSecond || !valid) throw new Error('Missing captured snapshot');
  await agentBriefingRouter
    .createCaller({ user: first.user })
    .updateContextPreferences({ enabled: false });
  await agentBriefingRouter
    .createCaller({ user: second.user })
    .updateContextPreferences({ enabled: false });
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ choices: [{ message: { content: 'Summary' } }] }));
  await Promise.all([
    runBriefingSummary(refusedFirst.id),
    runBriefingSummary(refusedSecond.id),
    runBriefingSummary(valid.id),
  ]);
  const finished = await db.select().from(agent_briefing_snapshots);
  for (const id of [refusedFirst.id, refusedSecond.id]) {
    const refused = finished.find(entry => entry.id === id);
    expect(refused?.summary.status).toBe('failed');
    expect(refused?.summary.error).toBe('permission_unavailable');
    expect(refused?.generation_id).toBeNull();
  }
  const admitted = finished.find(entry => entry.id === valid.id);
  expect(admitted?.summary.status).toBe('ready');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('records a pending row whose window closed as not admitted', async () => {
  const { now } = await scheduled();
  await sweepAgentBriefings(now);
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('No captured snapshot');
  const past = new Date(now.getTime() - 60_000).toISOString();
  await db
    .update(agent_briefing_snapshots)
    .set({ job_due_at: past, morning_end_at: past })
    .where(eq(agent_briefing_snapshots.id, row.id));
  await sweepAgentBriefings(new Date(now.getTime() + 60_000));
  const [expired] = await db.select().from(agent_briefing_snapshots);
  expect(expired?.summary.status).toBe('unavailable');
  expect(expired?.summary.error).toBe('not_admitted');
  expect(expired?.job_due_at).toBeNull();
});

it('keeps declined notification delivery due until a later accepted morning dispatch', async () => {
  const { user, now } = await scheduled();
  await db
    .update(agent_briefing_preferences)
    .set({ notifications_enabled: true })
    .where(eq(agent_briefing_preferences.kilo_user_id, user.id));
  const dispatch = jest.mocked(dispatchAgentBriefingPush);
  dispatch.mockClear();
  dispatch.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await sweepAgentBriefings(now);
  const [declined] = await db.select().from(agent_briefing_snapshots);
  expect(declined?.notification_sent_at).toBeNull();
  expect(dispatch).toHaveBeenCalledTimes(1);
  await sweepAgentBriefings(new Date(now.getTime() + 60_000));
  const [accepted] = await db.select().from(agent_briefing_snapshots);
  expect(accepted?.notification_sent_at).not.toBeNull();
  expect(dispatch).toHaveBeenCalledTimes(2);
  await sweepAgentBriefings(new Date(now.getTime() + 120_000));
  expect(dispatch).toHaveBeenCalledTimes(2);
});

it('does not retry declined notifications after the morning window ends', async () => {
  const { user, now } = await scheduled();
  await db
    .update(agent_briefing_preferences)
    .set({ notifications_enabled: true })
    .where(eq(agent_briefing_preferences.kilo_user_id, user.id));
  const dispatch = jest.mocked(dispatchAgentBriefingPush);
  dispatch.mockClear();
  dispatch.mockResolvedValue(false);
  await sweepAgentBriefings(now);
  await db
    .update(agent_briefing_snapshots)
    .set({ morning_end_at: new Date(now.getTime() + 30_000).toISOString() })
    .where(eq(agent_briefing_snapshots.kilo_user_id, user.id));
  await sweepAgentBriefings(new Date(now.getTime() + 60_000));
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('atomically initializes a fresh enabled context schedule in the requested timezone', async () => {
  const user = await insertTestUser({ total_microdollars_acquired: 10_000_000 });
  const caller = agentBriefingRouter.createCaller({ user });
  await caller.preferences({ timezone: 'Europe/Berlin', language: 'de' });
  expect(await db.select().from(agent_briefing_preferences)).toHaveLength(0);
  const estimate = await caller.estimateSummary({ model: 'test/snapshot' });
  expect(estimate.canGenerate).toBe(true);
  await expect(
    caller.updateContextPreferences({
      enabled: true,
      model: 'test/snapshot',
      estimateToken: estimate.estimateToken,
      timezone: 'invalid/timezone',
    })
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(await db.select().from(agent_briefing_preferences)).toHaveLength(0);
  const beforeEnable = Date.now();
  await caller.updateContextPreferences({
    enabled: true,
    model: 'test/snapshot',
    estimateToken: estimate.estimateToken,
    timezone: 'Europe/Berlin',
    language: 'de',
  });
  const [schedule] = await db.select().from(agent_briefing_preferences);
  if (!schedule) throw new Error('Missing initial schedule');
  expect(schedule.timezone).toBe('Europe/Berlin');
  expect(schedule.language).toBe('de');
  expect(Date.parse(schedule.next_run_at)).toBeGreaterThan(beforeEnable);
  expect(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(schedule.next_run_at))
  ).toBe('08:00');
  expect((await db.select().from(agent_briefing_context_preferences))[0]?.enabled).toBe(true);
  await caller.updateContextPreferences({
    enabled: true,
    model: 'test/snapshot',
    estimateToken: estimate.estimateToken,
    timezone: 'America/Los_Angeles',
    language: 'ja',
  });
  // The language rides every context update, so the stored row carries it; the
  // schedule's own fields (timezone and next run) stay on the first enable.
  expect((await db.select().from(agent_briefing_preferences))[0]).toEqual({
    ...schedule,
    language: 'ja',
    updated_at: expect.any(String),
  });
});

// A language-only update must not enroll a user who never enabled summaries:
// the schedule row's NOT NULL next_run_at would put them in the daily sweep.
it('leaves no schedule row when a context update only carries a language', async () => {
  const user = await insertTestUser({ total_microdollars_acquired: 10_000_000 });
  const caller = agentBriefingRouter.createCaller({ user });
  await expect(
    caller.updateContextPreferences({
      enabled: false,
      timezone: 'Europe/Berlin',
      language: 'de',
    })
  ).resolves.toBeDefined();
  expect(await db.select().from(agent_briefing_preferences)).toHaveLength(0);
});

function maintenanceSnapshot(
  userId: string,
  localDate: string
): typeof agent_briefing_snapshots.$inferInsert {
  return {
    kilo_user_id: userId,
    context_key: 'personal',
    timezone: 'UTC',
    language: 'en',
    local_date: localDate,
    night_start_at: '2026-10-27T22:00:00.000Z',
    cutoff_at: '2026-10-28T08:00:00.000Z',
    morning_end_at: '2026-10-28T12:00:00.000Z',
    captured_at: '2026-10-28T08:00:00.000Z',
    published_at: '2026-10-28T08:00:00.000Z',
    expires_at: '2026-11-27T08:00:00.000Z',
    facts: buildBriefingSnapshot([]),
    summary: emptySummary,
  };
}

it('terminally suppresses revoked notification sources so later eligible reports reach delivery', async () => {
  const user = await insertTestUser();
  await db.insert(agent_briefing_preferences).values({
    kilo_user_id: user.id,
    timezone: 'UTC',
    notifications_enabled: true,
    next_run_at: '2026-10-29T08:00:00.000Z',
  });
  const sources = await db
    .insert(cli_sessions_v2)
    .values(
      ['revoked', 'accessible'].map(id => ({
        kilo_user_id: user.id,
        session_id: `ses_${id}`,
        title: id,
        last_activity_at: '2026-10-28T07:00:00.000Z',
      }))
    )
    .returning();
  const revoked = sources.find(source => source.session_id === 'ses_revoked');
  const accessible = sources.find(source => source.session_id === 'ses_accessible');
  if (!revoked || !accessible) throw new Error('Missing source fixture');
  await db.insert(agent_briefing_snapshots).values(
    Array.from({ length: 100 }, (_, index) => ({
      ...maintenanceSnapshot(user.id, `revoked-${index}`),
      facts: buildBriefingSnapshot([revoked]),
    }))
  );
  const [eligible] = await db
    .insert(agent_briefing_snapshots)
    .values({
      ...maintenanceSnapshot(user.id, 'eligible'),
      cutoff_at: '2026-10-28T08:01:00.000Z',
      facts: buildBriefingSnapshot([accessible]),
    })
    .returning();
  if (!eligible) throw new Error('Missing eligible report');
  await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, revoked.session_id));
  const dispatch = jest.mocked(dispatchAgentBriefingPush);
  dispatch.mockClear();
  dispatch.mockResolvedValue(true);
  await sweepAgentBriefings(new Date('2026-10-28T08:10:00.000Z'));
  expect(dispatch).not.toHaveBeenCalled();
  const suppressed = await db.select().from(agent_briefing_snapshots);
  expect(suppressed.filter(row => row.summary.notificationSuppressed === true)).toHaveLength(100);
  expect(
    suppressed
      .filter(row => row.summary.notificationSuppressed === true)
      .every(row => row.notification_sent_at === null)
  ).toBe(true);
  await sweepAgentBriefings(new Date('2026-10-28T08:11:00.000Z'));
  expect(dispatch).toHaveBeenCalledTimes(1);
  const [delivered] = await db
    .select()
    .from(agent_briefing_snapshots)
    .where(eq(agent_briefing_snapshots.id, eligible.id));
  expect(delivered?.notification_sent_at).not.toBeNull();
});

it('repairs an expired running job behind an entire batch of still-open pending reports', async () => {
  const user = await insertTestUser();
  await db.insert(agent_briefing_snapshots).values(
    Array.from({ length: 100 }, (_, index) => ({
      ...maintenanceSnapshot(user.id, `pending-${index}`),
      job_due_at: '2026-10-28T08:00:00.000Z',
      summary: { ...emptySummary, status: 'pending' },
    }))
  );
  const [running] = await db
    .insert(agent_briefing_snapshots)
    .values({
      ...maintenanceSnapshot(user.id, 'running'),
      job_due_at: '2026-10-28T08:05:00.000Z',
      generation_id: 'agent-briefing:expired',
      generation_started_at: '2026-10-28T08:00:00.000Z',
      generation_deadline_at: '2026-10-28T08:05:00.000Z',
      summary: { ...emptySummary, status: 'running' },
    })
    .returning();
  if (!running) throw new Error('Missing running report');
  await sweepAgentBriefings(new Date('2026-10-28T08:10:00.000Z'));
  const rows = await db.select().from(agent_briefing_snapshots);
  expect(rows.find(row => row.id === running.id)?.summary.status).toBe('failed');
  expect(rows.find(row => row.id === running.id)?.job_due_at).toBeNull();
  expect(rows.filter(row => row.summary.status === 'pending')).toHaveLength(100);
});

it('leaves a running job within the expiry grace for its in-flight success write', async () => {
  const user = await insertTestUser();
  const [running] = await db
    .insert(agent_briefing_snapshots)
    .values({
      ...maintenanceSnapshot(user.id, 'running'),
      job_due_at: '2026-10-28T08:09:00.000Z',
      generation_id: 'agent-briefing:finishing',
      generation_started_at: '2026-10-28T08:00:00.000Z',
      generation_deadline_at: '2026-10-28T08:09:00.000Z',
      summary: { ...emptySummary, status: 'running' },
    })
    .returning();
  if (!running) throw new Error('Missing running report');
  await sweepAgentBriefings(new Date('2026-10-28T08:10:00.000Z'));
  const [row] = await db.select().from(agent_briefing_snapshots);
  expect(row?.summary.status).toBe('running');
  await sweepAgentBriefings(new Date('2026-10-28T08:11:00.000Z'));
  const [expired] = await db.select().from(agent_briefing_snapshots);
  expect(expired?.summary.status).toBe('failed');
});

it('recovers a stale due timestamp into the current morning without capturing multiple nights', async () => {
  const user = await insertTestUser();
  await db.insert(agent_briefing_preferences).values({
    kilo_user_id: user.id,
    timezone: 'UTC',
    next_run_at: '2026-10-27T08:00:00.000Z',
  });
  await db.insert(agent_briefing_context_preferences).values({
    kilo_user_id: user.id,
    context_key: 'personal',
    enabled: true,
    model: 'test/snapshot',
  });
  await db.insert(cli_sessions_v2).values([
    {
      kilo_user_id: user.id,
      session_id: 'ses_previous_night',
      last_activity_at: '2026-10-27T02:00:00.000Z',
    },
    {
      kilo_user_id: user.id,
      session_id: 'ses_current_night',
      last_activity_at: '2026-10-28T02:00:00.000Z',
    },
  ]);
  await sweepAgentBriefings(new Date('2026-10-28T08:05:00.000Z'));
  const [row] = await db.select().from(agent_briefing_snapshots);
  expect(row?.local_date).toBe('2026-10-28');
  expect(new Date(row?.night_start_at ?? '').toISOString()).toBe('2026-10-27T22:00:00.000Z');
  expect(new Date(row?.cutoff_at ?? '').toISOString()).toBe('2026-10-28T08:00:00.000Z');
  if (!row) throw new Error('Missing recovered snapshot');
  expect(row.summary.status).toBe('pending');
  expect(briefingFactsSchema.parse(row.facts).sessions.map(session => session.sessionId)).toEqual([
    'ses_current_night',
  ]);
  const [preferences] = await db.select().from(agent_briefing_preferences);
  expect(new Date(preferences?.next_run_at ?? '').toISOString()).toBe('2026-10-29T08:00:00.000Z');
});

it('does not expand an expired recovery occurrence into the following night', async () => {
  const user = await insertTestUser();
  await db.insert(agent_briefing_preferences).values({
    kilo_user_id: user.id,
    timezone: 'UTC',
    next_run_at: '2026-10-26T08:00:00.000Z',
  });
  await db.insert(agent_briefing_context_preferences).values({
    kilo_user_id: user.id,
    context_key: 'personal',
    enabled: true,
    model: 'test/snapshot',
  });
  await db.insert(cli_sessions_v2).values([
    {
      kilo_user_id: user.id,
      session_id: 'ses_recovered_night',
      last_activity_at: '2026-10-27T02:00:00.000Z',
    },
    {
      kilo_user_id: user.id,
      session_id: 'ses_following_night',
      last_activity_at: '2026-10-27T23:00:00.000Z',
    },
  ]);
  await sweepAgentBriefings(new Date('2026-10-28T07:00:00.000Z'));
  const [row] = await db.select().from(agent_briefing_snapshots);
  if (!row) throw new Error('Missing recovered snapshot');
  expect(row.local_date).toBe('2026-10-27');
  expect(row.summary.status).toBe('unavailable');
  expect(briefingFactsSchema.parse(row.facts).sessions.map(session => session.sessionId)).toEqual([
    'ses_recovered_night',
  ]);
});

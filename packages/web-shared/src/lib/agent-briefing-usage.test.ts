import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { agent_briefing_reports } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { recordBriefingUsage } from './agent-briefing-usage';
import type { UsageAccountingResult } from './ai-gateway/processUsage.types';

async function fixture(organizationId?: string) {
  const user = await insertTestUser();
  const generationId = `agent-briefing:${randomUUID()}`;
  const settlementToken = randomUUID();
  const previousGeneration = {
    id: `agent-briefing:${randomUUID()}`,
    settlementToken: randomUUID(),
    usageId: randomUUID(),
  };
  const summary = {
    status: 'failed',
    error: 'time_limit',
    text: null,
    costMicrodollars: 120,
    chargeStatus: 'pending',
    canRetry: false,
    retained: { value: 'preserved' },
    chargeAccounting: {
      baselineCostMicrodollars: 80,
      retained: 'accounting-field',
      generations: [previousGeneration, { id: generationId, settlementToken, usageId: null }],
    },
  };
  const now = new Date().toISOString();
  const [report] = await db
    .insert(agent_briefing_reports)
    .values({
      kilo_user_id: user.id,
      context_key: organizationId ?? 'personal',
      organization_id: organizationId,
      kind: 'one_off',
      night_start_at: now,
      cutoff_at: now,
      morning_end_at: now,
      evidence_hash: 'receipt-test',
      facts: { retained: 'facts' },
      summary,
      generation_id: generationId,
      next_charge_check_at: now,
    })
    .returning();
  if (!report) throw new Error('Report fixture was not inserted');
  return {
    report,
    summary,
    input: { kiloUserId: user.id, organizationId, generationId, settlementToken },
  };
}

async function readReport(id: string) {
  const [report] = await db
    .select()
    .from(agent_briefing_reports)
    .where(eq(agent_briefing_reports.id, id));
  if (!report) throw new Error('Report fixture was not found');
  return report;
}

function usage(status: UsageAccountingResult['status'] = 'recorded'): UsageAccountingResult {
  return { status, usageId: randomUUID(), createdAt: new Date().toISOString() };
}

describe('recordBriefingUsage', () => {
  it.each(['recorded', 'queued'] as const)(
    'stores the %s accounting identity while preserving report fields',
    async status => {
      const prepared = await fixture();
      const result = usage(status);
      await recordBriefingUsage({ ...prepared.input, usage: result });
      const persisted = await readReport(prepared.report.id);
      const expectedSummary = {
        ...prepared.summary,
        chargeAccounting: {
          ...prepared.summary.chargeAccounting,
          generations: prepared.summary.chargeAccounting.generations.map(entry =>
            entry.id === prepared.input.generationId ? { ...entry, usageId: result.usageId } : entry
          ),
        },
      };
      expect(persisted).toEqual({ ...prepared.report, summary: expectedSummary });
    }
  );

  it('retains the first accounting identity for repeated completion', async () => {
    const prepared = await fixture();
    const first = usage('queued');
    await recordBriefingUsage({ ...prepared.input, usage: first });
    const persisted = await readReport(prepared.report.id);
    await recordBriefingUsage({ ...prepared.input, usage: first });
    await recordBriefingUsage({ ...prepared.input, usage: usage() });
    expect(await readReport(prepared.report.id)).toEqual(persisted);
  });

  it('serializes concurrent completion identities', async () => {
    const prepared = await fixture();
    const first = usage();
    const second = usage();
    await Promise.all([
      recordBriefingUsage({ ...prepared.input, usage: first }),
      recordBriefingUsage({ ...prepared.input, usage: second }),
    ]);
    const persisted = await readReport(prepared.report.id);
    const accounting = persisted.summary.chargeAccounting;
    expect(accounting).toEqual({
      ...prepared.summary.chargeAccounting,
      generations: [
        prepared.summary.chargeAccounting.generations[0],
        {
          id: prepared.input.generationId,
          settlementToken: prepared.input.settlementToken,
          usageId: expect.stringMatching(`${first.usageId}|${second.usageId}`),
        },
      ],
    });
  });

  it('requires the generation capability and report owner', async () => {
    const prepared = await fixture();
    const otherUser = await insertTestUser();
    for (const changed of [
      { settlementToken: randomUUID() },
      { settlementToken: '' },
      { kiloUserId: otherUser.id },
      { generationId: `agent-briefing:${randomUUID()}` },
    ]) {
      await recordBriefingUsage({ ...prepared.input, ...changed, usage: usage() });
      expect(await readReport(prepared.report.id)).toEqual(prepared.report);
    }
  });

  it('requires exact personal and organization scope', async () => {
    const owner = await insertTestUser();
    const organization = await createTestOrganization('Receipt scope', owner.id, 0);
    const otherOrganization = await createTestOrganization('Other receipt scope', owner.id, 0);
    const personal = await fixture();
    const scoped = await fixture(organization.id);
    await recordBriefingUsage({
      ...personal.input,
      organizationId: organization.id,
      usage: usage(),
    });
    await recordBriefingUsage({ ...scoped.input, organizationId: undefined, usage: usage() });
    await recordBriefingUsage({
      ...scoped.input,
      organizationId: otherOrganization.id,
      usage: usage(),
    });
    expect(await readReport(personal.report.id)).toEqual(personal.report);
    expect(await readReport(scoped.report.id)).toEqual(scoped.report);
    const result = usage();
    await recordBriefingUsage({ ...scoped.input, usage: result });
    expect((await readReport(scoped.report.id)).summary).toMatchObject({
      chargeAccounting: {
        generations: [expect.anything(), expect.objectContaining({ usageId: result.usageId })],
      },
    });
  });

  it('requires the current generation and matching accounting entry', async () => {
    const prepared = await fixture();
    const previous = prepared.summary.chargeAccounting.generations[0];
    if (!previous) throw new Error('Previous generation fixture was not found');
    await recordBriefingUsage({
      ...prepared.input,
      generationId: previous.id,
      settlementToken: previous.settlementToken,
      usage: usage(),
    });
    expect(await readReport(prepared.report.id)).toEqual(prepared.report);
    await db
      .update(agent_briefing_reports)
      .set({ generation_id: `agent-briefing:${randomUUID()}` })
      .where(eq(agent_briefing_reports.id, prepared.report.id));
    const changed = await readReport(prepared.report.id);
    await recordBriefingUsage({ ...prepared.input, usage: usage() });
    expect(await readReport(prepared.report.id)).toEqual(changed);
  });

  it('leaves completion pending without an accounting outcome', async () => {
    const prepared = await fixture();
    await recordBriefingUsage({ ...prepared.input, usage: null });
    expect(await readReport(prepared.report.id)).toEqual(prepared.report);
  });

  it('requires a valid generation accounting structure', async () => {
    const prepared = await fixture();
    for (const chargeAccounting of [
      undefined,
      { baselineCostMicrodollars: -1, generations: [] },
      { baselineCostMicrodollars: 0, generations: [] },
      {
        baselineCostMicrodollars: 0,
        generations: [{ id: prepared.input.generationId, usageId: null }],
      },
      {
        ...prepared.summary.chargeAccounting,
        generations: [
          ...prepared.summary.chargeAccounting.generations,
          { id: prepared.input.generationId, settlementToken: randomUUID(), usageId: null },
        ],
      },
    ]) {
      await db
        .update(agent_briefing_reports)
        .set({ summary: { ...prepared.summary, chargeAccounting } })
        .where(eq(agent_briefing_reports.id, prepared.report.id));
      const changed = await readReport(prepared.report.id);
      await recordBriefingUsage({ ...prepared.input, usage: usage() });
      expect(await readReport(prepared.report.id)).toEqual(changed);
    }
  });
});

import { eq } from 'drizzle-orm';
import { agent_briefing_reports } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

import { listBriefings, serializeBriefing } from './store';

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 30;

const readableFacts = {
  scorecard: { sessions: 2, pullRequests: 1, blockers: 0, spendMicrodollars: 1200 },
  coverage: {
    activity: 'complete',
    spend: 'complete',
    blockers: 'complete',
    pullRequests: 'complete',
  },
  sessions: [],
  sources: [],
};

const readySummary = {
  status: 'ready',
  text: 'Two sessions overnight.',
  model: null,
  costMicrodollars: 0,
  chargeStatus: 'settled',
  estimatedCostMicrodollars: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  canRetry: false,
};

function briefingRow(input: {
  kiloUserId: string;
  contextKey: string;
  organizationId: string | null;
  daysAgo: number;
}) {
  const cutoff = new Date(Date.now() - input.daysAgo * DAY_MS);
  const cutoffAt = cutoff.toISOString();
  return {
    kilo_user_id: input.kiloUserId,
    context_key: input.contextKey,
    organization_id: input.organizationId,
    local_date: cutoffAt.slice(0, 10),
    night_start_at: new Date(cutoff.getTime() - 3 * 60 * 60_000).toISOString(),
    cutoff_at: cutoffAt,
    morning_end_at: new Date(cutoff.getTime() + 5 * 60 * 60_000).toISOString(),
    published_at: cutoffAt,
    updated_at: cutoffAt,
    revision: 1,
    evidence_hash: 'test-evidence',
    facts: readableFacts,
    summary: readySummary,
  };
}

describe('listBriefings', () => {
  it('pages through every report and skips one it cannot read', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Briefing history', user.id, 0);
    const rows = [];
    for (let day = 0; day < HISTORY_DAYS; day += 1) {
      const personal = briefingRow({
        kiloUserId: user.id,
        contextKey: 'personal',
        organizationId: null,
        daysAgo: day,
      });
      rows.push(
        day === HISTORY_DAYS - 1
          ? { ...personal, summary: { status: 'unknown-status' } }
          : personal,
        briefingRow({
          kiloUserId: user.id,
          contextKey: organization.id,
          organizationId: organization.id,
          daysAgo: day,
        })
      );
    }
    const inserted = await db.insert(agent_briefing_reports).values(rows).returning({
      id: agent_briefing_reports.id,
    });
    const reportId = (index: number) => {
      const row = inserted[index];
      if (!row) throw new Error(`no inserted report at ${index}`);
      return row.id;
    };
    const silentConsole = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const first = await listBriefings(user.id, { scope: 'all', limit: 30, currentOnly: false });
      expect(first.reports).toHaveLength(30);
      expect(first.nextCursor).not.toBeNull();
      const second = await listBriefings(user.id, {
        scope: 'all',
        limit: 30,
        currentOnly: false,
        cursor: first.nextCursor ?? undefined,
      });
      const loaded = [...first.reports, ...second.reports].map(report => report.id);
      expect(second.reports).toHaveLength(29);
      expect(second.nextCursor).toBeNull();
      expect(loaded).toHaveLength(59);
      expect(new Set(loaded).size).toBe(59);
      const unreadableIndex = 2 * (HISTORY_DAYS - 1);
      expect(loaded).not.toContain(reportId(unreadableIndex));
      expect(silentConsole).toHaveBeenCalledWith(
        'Agent briefing report skipped',
        expect.objectContaining({ reportId: reportId(unreadableIndex) })
      );
    } finally {
      silentConsole.mockRestore();
    }
  }, 120_000);
  it.each([0, 1])(
    'skips reports beyond the page envelope allowance (%i extra bytes)',
    async extraBytes => {
      const user = await insertTestUser();
      const inserted = await db
        .insert(agent_briefing_reports)
        .values(
          [0, 1, 2].map(daysAgo => ({
            ...briefingRow({
              kiloUserId: user.id,
              contextKey: 'personal',
              organizationId: null,
              daysAgo,
            }),
            summary: { ...readySummary, text: '' },
          }))
        )
        .returning();
      const [largeRow, ...olderRows] = inserted;
      if (!largeRow) throw new Error('No inserted report');
      const serialized = await serializeBriefing(largeRow);
      const text = 'x'.repeat(
        3_000_000 - Buffer.byteLength(JSON.stringify(serialized), 'utf8') + extraBytes
      );
      await db
        .update(agent_briefing_reports)
        .set({ summary: { ...readySummary, text } })
        .where(eq(agent_briefing_reports.id, largeRow.id));
      const silentConsole = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const first = await listBriefings(user.id, { limit: 1 });
        expect(first.reports).toEqual([]);
        expect(first.nextCursor).toBe(largeRow.id);
        const loaded: string[] = [];
        let cursor = first.nextCursor;
        for (let page = 0; cursor && page < olderRows.length; page += 1) {
          const result = await listBriefings(user.id, { limit: 1, cursor });
          expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(3_000_000);
          loaded.push(...result.reports.map(report => report.id));
          cursor = result.nextCursor;
        }
        expect(cursor).toBeNull();
        expect(loaded).toEqual(olderRows.map(row => row.id));
        expect(silentConsole).toHaveBeenCalledWith(
          'Agent briefing report skipped',
          expect.objectContaining({ reportId: largeRow.id })
        );
      } finally {
        silentConsole.mockRestore();
      }
    },
    120_000
  );

  it('keeps the next report reachable after a byte boundary and skipped row', async () => {
    const user = await insertTestUser();
    const inserted = await db
      .insert(agent_briefing_reports)
      .values(
        [0, 1, 2, 3].map(daysAgo => ({
          ...briefingRow({
            kiloUserId: user.id,
            contextKey: 'personal',
            organizationId: null,
            daysAgo,
          }),
          summary:
            daysAgo === 1
              ? { status: 'unknown-status' }
              : { ...readySummary, text: daysAgo < 3 ? 'é'.repeat(750_000) : '' },
        }))
      )
      .returning();
    const [firstRow, skippedRow, deferredRow, lastRow] = inserted;
    if (!firstRow || !skippedRow || !deferredRow || !lastRow) {
      throw new Error('Missing inserted reports');
    }
    const silentConsole = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const first = await listBriefings(user.id, { limit: 3 });
      expect(first.reports.map(report => report.id)).toEqual([firstRow.id]);
      expect(first.nextCursor).toBe(skippedRow.id);
      const second = await listBriefings(user.id, {
        limit: 3,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.reports.map(report => report.id)).toEqual([deferredRow.id, lastRow.id]);
      expect(second.nextCursor).toBeNull();
      for (const result of [first, second]) {
        expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(3_000_000);
      }
      const loaded = [...first.reports, ...second.reports].map(report => report.id);
      expect(new Set(loaded).size).toBe(3);
    } finally {
      silentConsole.mockRestore();
    }
  }, 120_000);

  it('includes envelope and separators in the combined page budget', async () => {
    const user = await insertTestUser();
    const inserted = await db
      .insert(agent_briefing_reports)
      .values(
        [0, 1].map(daysAgo => ({
          ...briefingRow({
            kiloUserId: user.id,
            contextKey: 'personal',
            organizationId: null,
            daysAgo,
          }),
          summary: { ...readySummary, text: '' },
        }))
      )
      .returning();
    const [firstRow, secondRow] = inserted;
    if (!firstRow || !secondRow) throw new Error('Missing inserted reports');
    const reports = await Promise.all(inserted.map(serializeBriefing));
    const reportBytes = reports.reduce(
      (total, report) => total + Buffer.byteLength(JSON.stringify(report), 'utf8'),
      0
    );
    await db
      .update(agent_briefing_reports)
      .set({ summary: { ...readySummary, text: 'x'.repeat(3_000_000 - reportBytes) } })
      .where(eq(agent_briefing_reports.id, firstRow.id));
    const first = await listBriefings(user.id, { limit: 2 });
    expect(first.reports.map(report => report.id)).toEqual([firstRow.id]);
    expect(first.nextCursor).toBe(firstRow.id);
    const second = await listBriefings(user.id, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.reports.map(report => report.id)).toEqual([secondRow.id]);
    expect(second.nextCursor).toBeNull();
    for (const result of [first, second]) {
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(3_000_000);
    }
  }, 120_000);

  it.each([0, -1, 1.9])(
    'uses a positive integer internal page size for %s',
    async limit => {
      const user = await insertTestUser();
      const inserted = await db
        .insert(agent_briefing_reports)
        .values(
          [0, 1].map(daysAgo =>
            briefingRow({
              kiloUserId: user.id,
              contextKey: 'personal',
              organizationId: null,
              daysAgo,
            })
          )
        )
        .returning({ id: agent_briefing_reports.id });
      const first = await listBriefings(user.id, { limit });
      expect(first.reports.map(report => report.id)).toEqual([inserted[0]?.id]);
      expect(first.nextCursor).toBe(inserted[0]?.id);
    },
    120_000
  );

  it('caps internal history pages at one hundred reports', async () => {
    const user = await insertTestUser();
    const organizations = await Promise.all(
      [1, 2, 3].map(index => createTestOrganization(`Briefing context ${index}`, user.id, 0))
    );
    const contexts = [null, ...organizations.map(organization => organization.id)];
    const rows = contexts.flatMap(organizationId =>
      Array.from({ length: 26 }, (_, daysAgo) =>
        briefingRow({
          kiloUserId: user.id,
          contextKey: organizationId ?? 'personal',
          organizationId,
          daysAgo,
        })
      )
    );
    const inserted = await db
      .insert(agent_briefing_reports)
      .values(rows)
      .returning({ id: agent_briefing_reports.id });
    const first = await listBriefings(user.id, { limit: 1000 });
    expect(first.reports).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const second = await listBriefings(user.id, {
      limit: 1000,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.reports).toHaveLength(4);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.reports, ...second.reports].map(report => report.id))).toEqual(
      new Set(inserted.map(row => row.id))
    );
  }, 120_000);
});

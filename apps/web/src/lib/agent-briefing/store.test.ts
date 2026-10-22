import { agent_briefing_reports } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

import { listBriefings } from './store';

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
});

import { db } from '@/lib/drizzle';
import {
  backfillCostInsightRollupsNewestFirst,
  initializeCostInsightRollupCoverage,
  reconcileCostInsightRollups,
  recordCostInsightDegradedInterval,
  recordCostInsightReconciliationSuccess,
} from '@/lib/cost-insights/rollup-maintenance';
import { requireUtcHour } from '@/lib/cost-insights/canonical-sources';

const HOUR_MS = 60 * 60 * 1_000;

export type CostInsightRollupScriptArgs = {
  execute: boolean;
  startHour: string;
  endHourExclusive: string;
  maxHours: number;
  sleepMs: number;
  liveCaptureStartHour?: string;
};

function usage(): string {
  return [
    'Usage:',
    '  pnpm --filter web script:run db cost-insights-rollups --start-hour <UTC-hour> --end-hour <exclusive-UTC-hour> --max-hours <count> [--sleep-ms <ms>] [--execute] [--live-capture-start-hour <UTC-hour>]',
    '',
    'Defaults to dry-run reconciliation. --execute performs absolute newest-first hourly replacement.',
    'First execution must set --live-capture-start-hour to the first full UTC hour after all writers were deployed.',
    'Both bounds must be exact UTC hours; --end-hour is exclusive and cannot exceed current completed-hour boundary.',
  ].join('\n');
}

function parseNonNegativeInteger(value: string | undefined, flag: string): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a non-negative integer.\n${usage()}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} exceeds the JavaScript safe-integer range.\n${usage()}`);
  }
  return parsed;
}

export function parseCostInsightRollupScriptArgs(args: string[]): CostInsightRollupScriptArgs {
  let execute = false;
  let startHour: string | undefined;
  let endHourExclusive: string | undefined;
  let maxHours: number | undefined;
  let sleepMs = 0;
  let liveCaptureStartHour: string | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) {
      throw new Error(`Duplicate flag: ${flag}.\n${usage()}`);
    }
    seen.add(flag);
    if (flag === '--execute') {
      execute = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}.\n${usage()}`);
    }
    index++;
    if (flag === '--start-hour') {
      startHour = requireUtcHour(value, '--start-hour');
    } else if (flag === '--end-hour') {
      endHourExclusive = requireUtcHour(value, '--end-hour');
    } else if (flag === '--max-hours') {
      maxHours = parseNonNegativeInteger(value, '--max-hours');
    } else if (flag === '--sleep-ms') {
      sleepMs = parseNonNegativeInteger(value, '--sleep-ms');
    } else if (flag === '--live-capture-start-hour') {
      liveCaptureStartHour = requireUtcHour(value, '--live-capture-start-hour');
    } else {
      throw new Error(`Unknown flag: ${flag}.\n${usage()}`);
    }
  }

  if (!startHour || !endHourExclusive || maxHours === undefined || maxHours === 0) {
    throw new Error(usage());
  }
  const hourCount = (Date.parse(endHourExclusive) - Date.parse(startHour)) / HOUR_MS;
  if (!Number.isInteger(hourCount) || hourCount <= 0 || hourCount > maxHours) {
    throw new Error(`Requested range must contain 1-${maxHours} UTC hours.\n${usage()}`);
  }
  const currentCompletedHourBoundary = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  if (Date.parse(endHourExclusive) > currentCompletedHourBoundary) {
    throw new Error(`--end-hour must not include current or future UTC hours.\n${usage()}`);
  }
  if (liveCaptureStartHour && !execute) {
    throw new Error(`--live-capture-start-hour requires --execute.\n${usage()}`);
  }

  return {
    execute,
    startHour,
    endHourExclusive,
    maxHours,
    sleepMs,
    ...(liveCaptureStartHour ? { liveCaptureStartHour } : {}),
  };
}

function printReconciliation(
  report: Awaited<ReturnType<typeof reconcileCostInsightRollups>>,
  mode: 'dry-run' | 'post-execute-reconciliation'
): void {
  console.log(
    JSON.stringify(
      {
        mode,
        startHour: report.startHour,
        endHourExclusive: report.endHourExclusive,
        checkedHourCount: report.checkedHourCount,
        mismatchCount: report.mismatchCount,
        mismatchCounts: report.mismatchCounts,
        detailsTruncated: report.detailsTruncated,
        mismatches: report.mismatches,
      },
      null,
      2
    )
  );
}

export async function run(...args: string[]): Promise<void> {
  const parsed = parseCostInsightRollupScriptArgs(args);
  if (!parsed.execute) {
    const report = await reconcileCostInsightRollups(db, {
      startHour: parsed.startHour,
      endHourExclusive: parsed.endHourExclusive,
      maxHours: parsed.maxHours,
    });
    printReconciliation(report, 'dry-run');
    return;
  }

  if (parsed.liveCaptureStartHour) {
    await initializeCostInsightRollupCoverage(db, parsed.liveCaptureStartHour);
  }
  console.log(
    JSON.stringify({
      mode: 'execute',
      order: 'newest-first',
      startHour: parsed.startHour,
      endHourExclusive: parsed.endHourExclusive,
      maxHours: parsed.maxHours,
      sleepMs: parsed.sleepMs,
      liveCaptureStartHour: parsed.liveCaptureStartHour ?? null,
    })
  );
  await backfillCostInsightRollupsNewestFirst(db, {
    startHour: parsed.startHour,
    endHourExclusive: parsed.endHourExclusive,
    maxHours: parsed.maxHours,
    sleepMs: parsed.sleepMs,
    onHourComplete: result => {
      console.log(JSON.stringify({ mode: 'execute-hour', ...result }));
    },
  });

  const report = await reconcileCostInsightRollups(db, {
    startHour: parsed.startHour,
    endHourExclusive: parsed.endHourExclusive,
    maxHours: parsed.maxHours,
  });
  printReconciliation(report, 'post-execute-reconciliation');
  if (report.mismatchCount > 0) {
    const degradedIntervalId = await recordCostInsightDegradedInterval(db, {
      startHour: parsed.startHour,
      endHourExclusive: parsed.endHourExclusive,
      reason: 'reconciliation_mismatch',
    });
    throw new Error(
      `Cost Insights reconciliation found mismatches; degraded interval ${degradedIntervalId} remains unresolved.`
    );
  }
  await recordCostInsightReconciliationSuccess(db);
}

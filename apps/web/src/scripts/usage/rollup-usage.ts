/**
 * Manual rollup script for `microdollar_usage` analytics.
 *
 * Computes hourly/daily/monthly rollups (both wide and totals variants) from
 * `microdollar_usage` + `microdollar_usage_metadata` into `usage_rollup_*`
 * tables. Idempotent per day: reprocessing a day deletes and re-inserts its
 * rows.
 *
 * Usage:
 *   pnpm script:run usage rollup-usage -- --from 2024-01-01 --to 2024-12-31
 *   pnpm script:run usage rollup-usage -- --yesterday
 *   pnpm script:run usage rollup-usage -- --all-time
 *   pnpm script:run usage rollup-usage -- --cleanup
 *   pnpm script:run usage rollup-usage -- --dry-run --yesterday
 *
 * Flags:
 *   --from <YYYY-MM-DD>   Start date (inclusive).
 *   --to <YYYY-MM-DD>     End date (inclusive).
 *   --yesterday           Process only yesterday (UTC).
 *   --all-time            Process from earliest usage to yesterday (UTC).
 *   --cleanup             Delete rows beyond retention policy.
 *   --dry-run             Print plan; do not write.
 */

import {
  processDay,
  processMonth,
  updateWatermark,
  cleanupRetention,
  getEarliestUsageDate,
  iterateDays,
  monthOfDay,
} from '@/lib/usage-analytics/rollup';

type Args = {
  from?: string;
  to?: string;
  yesterday: boolean;
  allTime: boolean;
  cleanup: boolean;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    yesterday: false,
    allTime: false,
    cleanup: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue; // pnpm separator; ignore
    if (a === '--from') {
      args.from = argv[++i];
    } else if (a === '--to') {
      args.to = argv[++i];
    } else if (a === '--yesterday') {
      args.yesterday = true;
    } else if (a === '--all-time') {
      args.allTime = true;
    } else if (a === '--cleanup') {
      args.cleanup = true;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else {
      console.warn(`Unknown arg: ${a}`);
    }
  }
  return args;
}

function yesterdayIso(): string {
  const now = new Date();
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)
  );
  return yesterday.toISOString().slice(0, 10);
}

function validateDateIso(s: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`${label} must be YYYY-MM-DD, got: ${s}`);
  }
}

export async function run(...argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.cleanup) {
    if (args.dryRun) {
      console.log('[dry-run] Would delete rows beyond retention window.');
      return;
    }
    const counts = await cleanupRetention();
    console.log(
      `Cleanup complete: hourly=${counts.hourly} hourlyTotals=${counts.hourlyTotals} daily=${counts.daily} dailyTotals=${counts.dailyTotals}`
    );
    return;
  }

  let fromIso: string;
  let toIso: string;

  if (args.allTime) {
    const earliest = await getEarliestUsageDate();
    if (!earliest) {
      console.log('No usage data found.');
      return;
    }
    fromIso = earliest.slice(0, 10);
    toIso = yesterdayIso();
  } else if (args.yesterday) {
    fromIso = yesterdayIso();
    toIso = fromIso;
  } else if (args.from && args.to) {
    validateDateIso(args.from, '--from');
    validateDateIso(args.to, '--to');
    fromIso = args.from;
    toIso = args.to;
  } else {
    throw new Error(
      'Must specify --yesterday, --all-time, --cleanup, or --from <date> --to <date>.'
    );
  }

  console.log(
    `Rolling up usage from ${fromIso} to ${toIso} (inclusive)${args.dryRun ? ' [dry-run]' : ''}`
  );

  const startMs = Date.now();
  let daysProcessed = 0;
  const monthsToProcess = new Set<string>();
  const totals = {
    hourlyWide: 0,
    hourlyTotals: 0,
    dailyWide: 0,
    dailyTotals: 0,
  };

  for (const dayIso of iterateDays(fromIso, toIso)) {
    if (args.dryRun) {
      console.log(`[dry-run] Would process ${dayIso}`);
      monthsToProcess.add(monthOfDay(dayIso));
      daysProcessed++;
      continue;
    }
    const dayStart = Date.now();
    const counts = await processDay(dayIso);
    const dayDurationMs = Date.now() - dayStart;
    totals.hourlyWide += counts.hourlyWide;
    totals.hourlyTotals += counts.hourlyTotals;
    totals.dailyWide += counts.dailyWide;
    totals.dailyTotals += counts.dailyTotals;
    monthsToProcess.add(monthOfDay(dayIso));
    daysProcessed++;
    console.log(
      `[${dayIso}] hourlyWide=${counts.hourlyWide} hourlyTotals=${counts.hourlyTotals} dailyWide=${counts.dailyWide} dailyTotals=${counts.dailyTotals} (${dayDurationMs}ms)`
    );
  }

  // Recompute each distinct month touched
  for (const monthIso of Array.from(monthsToProcess).sort()) {
    if (args.dryRun) {
      console.log(`[dry-run] Would recompute month ${monthIso}`);
      continue;
    }
    const monthStart = Date.now();
    const monthly = await processMonth(monthIso);
    const monthDurationMs = Date.now() - monthStart;
    console.log(
      `[month=${monthIso}] monthlyWide=${monthly.monthlyWide} monthlyTotals=${monthly.monthlyTotals} (${monthDurationMs}ms)`
    );
  }

  if (!args.dryRun) {
    // Update watermarks to the end of the processed range
    const lastCompletedIso = new Date(`${toIso}T23:59:59.999Z`).toISOString();
    await updateWatermark('hourly', lastCompletedIso);
    await updateWatermark('daily', lastCompletedIso);
    await updateWatermark('monthly', lastCompletedIso);
  }

  const elapsedSeconds = (Date.now() - startMs) / 1000;
  console.log(
    `\nSummary: ${daysProcessed} days, ${monthsToProcess.size} months in ${elapsedSeconds.toFixed(1)}s`
  );
  console.log(
    `Totals: hourlyWide=${totals.hourlyWide} hourlyTotals=${totals.hourlyTotals} dailyWide=${totals.dailyWide} dailyTotals=${totals.dailyTotals}`
  );
}

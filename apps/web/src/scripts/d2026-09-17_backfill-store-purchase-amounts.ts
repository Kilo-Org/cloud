/**
 * One-off backfill of `amount_charged_minor_units`, `currency`, and
 * `tax_minor_units` on existing Google Play purchases in
 * `kilo_pass_store_purchases` (see
 * `@/lib/kilo-pass/store-purchase-money-backfill`).
 *
 * The stored receipt cannot supply the money, so each purchase's Play order is
 * re-read through the stored `provider_transaction_id`. Rows whose order Google
 * can no longer return stay NULL and are counted in the summary as `skipped`
 * (no money in the order) or `failed` (the lookup itself failed). The run is
 * idempotent and resumable: only rows that still have both amounts NULL are
 * selected, newest purchase first, at most `--limit` per call.
 *
 * Requires GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON in the target environment.
 *
 * Usage:
 *   pnpm --filter web script src/scripts/d2026-09-17_backfill-store-purchase-amounts.ts --limit 500
 *   pnpm --filter web script src/scripts/d2026-09-17_backfill-store-purchase-amounts.ts --limit 500 --dry-run
 */

import '../lib/load-env';

import { closeAllDrizzleConnections } from '@/lib/drizzle';
import {
  backfillGooglePlayPurchaseAmounts,
  DEFAULT_BACKFILL_GOOGLE_PLAY_PURCHASE_AMOUNTS_LIMIT,
} from '@/lib/kilo-pass/store-purchase-money-backfill';

const USAGE = [
  'Backfills amount, currency, and tax on existing Google Play Kilo Pass purchases.',
  '',
  'Usage:',
  '  pnpm --filter web script src/scripts/d2026-09-17_backfill-store-purchase-amounts.ts [--limit <n>] [--dry-run]',
  '',
  `  --limit <n>  Maximum purchases to process. Defaults to ${DEFAULT_BACKFILL_GOOGLE_PLAY_PURCHASE_AMOUNTS_LIMIT}.`,
  '  --dry-run    Count the batch without writing any update.',
  '  --help       Print this message.',
  '',
  'Requires GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON in the target environment:',
  'the Play order API is the only source of a purchase amount, currency, and tax.',
].join('\n');

function parseLimit(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --limit: ${raw}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): { limit: number; dryRun: boolean; help: boolean } {
  let limit = DEFAULT_BACKFILL_GOOGLE_PLAY_PURCHASE_AMOUNTS_LIMIT;
  let dryRun = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--limit') {
      const raw = argv[index + 1];
      if (raw === undefined) throw new Error('--limit requires a value');
      limit = parseLimit(raw);
      index += 1;
    } else if (arg.startsWith('--limit=')) {
      limit = parseLimit(arg.slice('--limit='.length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { limit, dryRun, help };
}

async function main(): Promise<void> {
  const { limit, dryRun, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    return;
  }

  console.log('Requires GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON in the environment.');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'}, limit: ${limit}`);

  const startedAt = Date.now();
  const result = await backfillGooglePlayPurchaseAmounts({ limit, dryRun });

  console.log(
    `scanned=${result.scanned} updated=${result.updated} skipped=${result.skipped} failed=${result.failed}`
  );
  console.log(`Duration: ${Date.now() - startedAt}ms`);
}

void main()
  .catch(error => {
    console.error('Fatal error:', error);
    process.exitCode = 1;
  })
  .finally(() => closeAllDrizzleConnections());

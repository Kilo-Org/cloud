/**
 * One-off backfill of `amount_charged_minor_units`, `currency`, and
 * `tax_minor_units` on existing Google Play purchases in
 * `kilo_pass_store_purchases` (see
 * `@/lib/kilo-pass/store-purchase-money-backfill`).
 *
 * The stored receipt cannot supply the money, so each purchase's Play order is
 * re-read through the stored `provider_transaction_id`. Rows whose order Google
 * can no longer return are counted in the summary as `skipped` (no money in the
 * order) or `failed` (the lookup itself failed). A skipped row is retired after
 * that one attempt, so repeated runs converge; a failed row stays eligible and
 * the next run retries it. Each failure also prints one `[FAILED]` line with the
 * purchase row id, the Play order id, and the error message, so a credential
 * problem, a quota rejection, and one bad order are distinguishable without
 * dumping credential material. The run is idempotent and resumable: only rows
 * that are not settled yet and still have both amounts NULL are selected,
 * newest purchase first, at most `--limit` per call.
 *
 * Requires GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON in the target environment.
 * The service account is validated before the first Play request, so a missing
 * or malformed value exits non-zero instead of reporting `failed=N`.
 *
 * Usage:
 *   pnpm --filter web script src/scripts/d2026-09-17_backfill-store-purchase-amounts.ts --limit 500
 *   pnpm --filter web script src/scripts/d2026-09-17_backfill-store-purchase-amounts.ts --limit 500 --dry-run
 */

import '../lib/load-env';

import { closeAllDrizzleConnections } from '@/lib/drizzle';
import { assertGooglePlayServiceAccountConfigured } from '@/lib/kilo-pass/google-play-sdk';
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

  // Fail fast, before the first query or Play request: a missing or malformed
  // service account would otherwise fail every order lookup and be reported
  // only as `failed=N`. The message names the variable; the value is never
  // printed.
  assertGooglePlayServiceAccountConfigured();
  console.log('GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON: set and valid');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'}, limit: ${limit}`);

  const startedAt = Date.now();
  const result = await backfillGooglePlayPurchaseAmounts({ limit, dryRun });

  for (const failure of result.failures) {
    // Message only: an auth failure's payload or stack can carry key material.
    console.error(`[FAILED] row=${failure.rowId} order=${failure.orderId} error=${failure.reason}`);
  }

  console.log(
    `scanned=${result.scanned} updated=${result.updated} skipped=${result.skipped} failed=${result.failed}`
  );
  if (result.failed > 0) {
    console.log(
      'Next: re-run the same command to retry the failed rows. If every failure repeats one ' +
        'error, check the service account (credentials, quota, or Play project) before retrying.'
    );
  }
  console.log(`Duration: ${Date.now() - startedAt}ms`);
}

void main()
  .catch(error => {
    console.error('Fatal error:', error);
    process.exitCode = 1;
  })
  .finally(() => closeAllDrizzleConnections());

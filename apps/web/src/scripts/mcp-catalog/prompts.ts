/**
 * CLI entry point: writes the summary-prompt artifact for the CI summary
 * pipeline.
 *
 * Enumerates the router graph of the current checkout, determines which
 * catalog paths are missing summaries, and writes the exact prompt batches
 * the trusted completion step will send to the Kilo CLI. The artifact
 * carries the prompt text and the pinned model and variant for each batch.
 *
 * Usage (from apps/web):
 *   pnpm script src/scripts/mcp-catalog/prompts.ts -- <output.json>
 *
 * Output shape:
 *   { "batches": [{ "label": "billing.ts", "prompt": "…" }], "missingCount": 3 }
 *
 * Exits 0 with `"batches": []` when nothing is missing (the fast path an
 * unrelated PR takes), and fails when the artifact path is absent or the
 * enumeration produces no catalog rows.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnvFile } from 'dotenv';
import '../../lib/load-env';
import {
  SUMMARY_MODEL,
  SUMMARY_VARIANT,
  buildCatalogRows,
  buildSummaryBatches,
  collectCatalogLeaves,
  readCommittedSummaries,
  renderSummaryPrompt,
} from './catalog';

// The dump imports the whole router graph, so it needs the app's import-time
// env. Jest solves the same need by layering .env.test in globalSetup; mirror
// that here without overriding .env / .env.local, so a real developer
// environment always wins and the script runs in any checkout.
loadEnvFile({ path: join(__dirname, '..', '..', '..', '.env.test') });

// IS_SCRIPT mode (set by `pnpm script`) demands a dedicated script database
// connection string; this script never touches the database, so the ordinary
// connection string suffices when the script one is unset.
if (!process.env.POSTGRES_SCRIPT_URL) {
  process.env.POSTGRES_SCRIPT_URL = process.env.POSTGRES_URL;
}

async function main(): Promise<void> {
  // `pnpm --filter web script <file> -- <args>` passes the `--` separator
  // through to tsx; drop it so the artifact path lands in args[0].
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  const output = args[0];
  if (!output) {
    console.error('❌ usage: prompts.ts <output.json>');
    process.exit(1);
  }

  const { rootRouter } = await import('@/routers/root-router');

  const leaves = collectCatalogLeaves(rootRouter);
  const committed = readCommittedSummaries();
  const { missing } = buildCatalogRows(leaves, committed);
  if (missing.length === 0) {
    writeFileSync(
      output,
      JSON.stringify(
        {
          batches: [],
          missingCount: 0,
          model: SUMMARY_MODEL,
          variant: SUMMARY_VARIANT,
        },
        null,
        2
      )
    );
    console.log(
      `✅ every catalog path has a summary — wrote an empty prompt artifact to ${output}`
    );
    return;
  }

  const batches = buildSummaryBatches(missing).map(batch => ({
    label: batch.label,
    prompt: renderSummaryPrompt(batch),
  }));
  writeFileSync(
    output,
    JSON.stringify(
      {
        batches,
        missingCount: missing.length,
        model: SUMMARY_MODEL,
        variant: SUMMARY_VARIANT,
      },
      null,
      2
    )
  );
  console.log(
    `✅ wrote ${batches.length} prompt ${batches.length === 1 ? 'batch' : 'batches'} for ${missing.length} missing summaries to ${output}`
  );
}

main().catch((error: unknown) => {
  console.error('❌', error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});

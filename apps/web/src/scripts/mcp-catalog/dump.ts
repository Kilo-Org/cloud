/**
 * CLI entry point: dumps the tRPC catalog (queries and mutations, minus the
 * admin/debug/test denylist) to services/kilo-mcp/catalog.json.
 *
 * Usage (from apps/web):
 *   pnpm script src/scripts/mcp-catalog/dump.ts              # write or regenerate
 *   pnpm script src/scripts/mcp-catalog/dump.ts -- --check    # exit 0 iff regenerating is byte-identical
 *   pnpm script src/scripts/mcp-catalog/dump.ts -- --dry-run  # print row counts only
 *   pnpm script src/scripts/mcp-catalog/dump.ts -- --summaries-file summaries.json
 *           # CI apply path: merge pre-generated summaries (from the trusted
 *           # CI completion step) instead of calling the Kilo CLI; every
 *           # missing path must be covered or the run fails
 *
 * Summaries come from the committed catalog when present (authors edit them
 * there; this script never clobbers them) and are generated via LLM for new
 * procedures. Without LLM credentials and missing summaries the dump fails
 * rather than writing an incomplete catalog.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config as loadEnvFile } from 'dotenv';
import '../../lib/load-env';
import {
  CATALOG_JSON_DISPLAY_PATH,
  CATALOG_JSON_PATH,
  CatalogSummaryError,
  buildCatalogJson,
  buildCatalogRows,
  collectCatalogLeaves,
  generateMissingSummaries,
  readCommittedSummaries,
  runKiloCompletion,
  type CatalogLeaf,
  type CatalogRow,
} from './catalog';

// The dump imports the whole router graph, so it needs the app's import-time
// env. Jest solves the same need by layering .env.test in globalSetup; mirror
// that here without overriding .env / .env.local, so a real developer
// environment always wins and the dump runs in any checkout.
loadEnvFile({ path: join(__dirname, '..', '..', '..', '.env.test') });

// IS_SCRIPT mode (set by `pnpm script`) demands a dedicated script DB URL;
// the dump never touches the database, so a placeholder suffices when unset.
if (!process.env.POSTGRES_SCRIPT_URL) {
  process.env.POSTGRES_SCRIPT_URL = 'postgres://catalog-dump.invalid:5432/catalog';
}

/**
 * The dump only imports the router graph to enumerate it statically — it never
 * calls the app, the database, or any worker.
 */

function diffPaths(
  before: string,
  after: string
): { added: string[]; removed: string[]; changed: string[] } {
  const parse = (json: string): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(json) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  const beforeRows = parse(before);
  const afterRows = parse(after);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, row] of Object.entries(afterRows)) {
    if (!(path in beforeRows)) added.push(path);
    else if (JSON.stringify(beforeRows[path]) !== JSON.stringify(row)) changed.push(path);
  }
  for (const path of Object.keys(beforeRows)) {
    if (!(path in afterRows)) removed.push(path);
  }
  return { added, removed, changed };
}

/** Per-kind row counts for CLI output: `query 12, mutation 10`. */
function countByKind(rows: CatalogRow[], missing: CatalogLeaf[]): string {
  let queries = 0;
  let mutations = 0;
  for (const row of rows) {
    if (row.kind === 'mutation') mutations += 1;
    else queries += 1;
  }
  for (const leaf of missing) {
    if (leaf.type === 'mutation') mutations += 1;
    else queries += 1;
  }
  return `query ${queries}, mutation ${mutations}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const dryRun = args.includes('--dry-run');
  const summariesFlagIndex = args.indexOf('--summaries-file');
  const summariesFile = summariesFlagIndex === -1 ? undefined : args[summariesFlagIndex + 1];
  if (
    summariesFlagIndex !== -1 &&
    (summariesFile === undefined || summariesFile.startsWith('--'))
  ) {
    console.error('❌ --summaries-file requires a file path argument');
    process.exit(1);
  }
  if (check && dryRun) {
    console.error('❌ --check and --dry-run are mutually exclusive');
    process.exit(1);
  }
  if (summariesFile !== undefined && (check || dryRun)) {
    console.error('❌ --summaries-file is only valid on a writing run');
    process.exit(1);
  }

  const { rootRouter } = await import('@/routers/root-router');

  const leaves = collectCatalogLeaves(rootRouter);
  const committed = readCommittedSummaries();
  const { rows: committedRows, missing } = buildCatalogRows(leaves, committed);
  let rows = committedRows;

  if (dryRun) {
    console.log(`Catalog dry run for ${CATALOG_JSON_DISPLAY_PATH}`);
    console.log(`  procedures enumerated:   ${leaves.length}`);
    console.log(
      `  catalog rows:            ${rows.length + missing.length} (${countByKind(rows, missing)})`
    );
    console.log(`  with committed summary:  ${rows.length}`);
    console.log(`  missing summary (LLM):   ${missing.length}`);
    return;
  }

  if (summariesFile !== undefined) {
    // CI apply path: the summaries were generated by the trusted completion
    // job, which runs without a repository checkout. Coverage must be exact:
    // a missing path left uncovered would drop its procedure from the
    // emitted catalog, so fail loudly instead of writing an incomplete file.
    const raw = JSON.parse(readFileSync(summariesFile, 'utf8')) as unknown;
    if (
      raw === null ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.values(raw).some(value => typeof value !== 'string')
    ) {
      throw new Error(
        `Summary file ${summariesFile} must be a JSON object mapping procedure paths to summary strings`
      );
    }
    const generated = new Map(Object.entries(raw as Record<string, string>));
    // A generated summary may never overwrite a committed (author-edited)
    // row. Extra keys that are neither missing nor committed overwrite
    // nothing and are ignored, mirroring the runner-side filter to the
    // requested batch paths.
    const collisions = [...generated.keys()].filter(path => committed.has(path));
    if (collisions.length > 0) {
      throw new Error(
        `Summary file ${summariesFile} carries summaries for ${collisions.length} already-committed ${collisions.length === 1 ? 'path' : 'paths'}: ${collisions.join(', ')}`
      );
    }
    const uncovered = missing
      .map(leaf => leaf.path)
      .filter(path => {
        const summary = generated.get(path);
        return typeof summary !== 'string' || summary.trim() === '';
      });
    if (uncovered.length > 0) {
      throw new Error(
        `Summary file ${summariesFile} does not cover ${uncovered.length} missing ${uncovered.length === 1 ? 'path' : 'paths'}: ${uncovered.join(', ')}`
      );
    }
    // Rebuild from the full leaf set so every row carries its final summary.
    ({ rows } = buildCatalogRows(leaves, new Map([...committed, ...generated])));
    console.log(
      `✅ applied ${generated.size} generated summaries for ${missing.length} missing paths from ${summariesFile}`
    );
  } else if (missing.length > 0) {
    console.log(`🧠 Generating ${missing.length} missing summaries via the Kilo CLI…`);
    const generated = await generateMissingSummaries(missing, runKiloCompletion, message =>
      console.log(message)
    );
    // Rebuild from the full leaf set so every row carries its final summary.
    ({ rows } = buildCatalogRows(leaves, new Map([...committed, ...generated])));
  }

  const json = buildCatalogJson(rows);

  if (check) {
    if (!existsSync(CATALOG_JSON_PATH)) {
      console.error(
        `❌ ${CATALOG_JSON_DISPLAY_PATH} does not exist — run the dump without --check first`
      );
      process.exit(1);
    }
    const onDisk = readFileSync(CATALOG_JSON_PATH, 'utf8');
    if (onDisk === json) {
      console.log(`✅ ${CATALOG_JSON_DISPLAY_PATH} is up to date (${rows.length} rows)`);
      return;
    }
    const { added, removed, changed } = diffPaths(onDisk, json);
    console.error(
      `❌ ${CATALOG_JSON_DISPLAY_PATH} is stale: regenerating produces a different file`
    );
    if (added.length > 0)
      console.error(
        `   added paths:   ${added.slice(0, 10).join(', ')}${added.length > 10 ? ` … (+${added.length - 10} more)` : ''}`
      );
    if (removed.length > 0)
      console.error(
        `   removed paths: ${removed.slice(0, 10).join(', ')}${removed.length > 10 ? ` … (+${removed.length - 10} more)` : ''}`
      );
    if (changed.length > 0)
      console.error(
        `   changed rows:  ${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ` … (+${changed.length - 10} more)` : ''}`
      );
    process.exit(1);
  }

  mkdirSync(dirname(CATALOG_JSON_PATH), { recursive: true });
  writeFileSync(CATALOG_JSON_PATH, json);
  console.log(
    `✅ wrote ${CATALOG_JSON_DISPLAY_PATH} (${rows.length} rows: ${countByKind(rows, [])})`
  );
}

main().catch((error: unknown) => {
  if (error instanceof CatalogSummaryError && error.retryable) {
    console.error(`⏳ ${error.message}`);
    console.error('   This looks transient — retry the command once the provider is reachable.');
  } else if (error instanceof Error) {
    console.error('❌', error.message);
    if (error.stack) console.error(error.stack);
  } else {
    console.error('❌', error);
  }
  process.exit(1);
});

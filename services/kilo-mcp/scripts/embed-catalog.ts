/// <reference types="node" />
/**
 * Embed the Kilo catalog and upsert it into Vectorize.
 *
 * Reads services/kilo-mcp/catalog.json, embeds every row's searchBlob via the
 * Cloudflare REST API (Workers AI run endpoint), and upserts the vectors with
 * the procedure path as vector id (requirement 9) and {path, kind, tags} as
 * metadata. Batches at ≤64 rows per request. When `MCP_CATALOG_PRUNE_IDS`
 * names a file of every procedure path the index was ever built from, it then
 * deletes the ids that are missing from the current catalog, so a removed or
 * renamed procedure stops competing for kNN slots. The prune reads git history,
 * never the index: listing the whole production index times out, and a history
 * union means one failed run cannot strand a vector.
 *
 * Subcommands:
 *   (none)|upsert  embed + upsert every catalog row, then prune the ids the
 *                  current catalog no longer has
 *   ensure-index   create the Vectorize index idempotently (pinned dimensions
 *                  and metric from src/embedding.ts), then exit
 *
 * Referenced ONLY by the main-branch merge job and the one-time bootstrap —
 * never by PR jobs (requirement 10).
 *
 * Env (all required):
 *   CLOUDFLARE_ACCOUNT_ID   Cloudflare account id
 *   CLOUDFLARE_API_TOKEN    API token with Workers AI + Vectorize permissions
 *   VECTORIZE_INDEX_NAME    index name, e.g. kilo-mcp-catalog-dev
 *
 * Env (optional):
 *   MCP_CATALOG_PRUNE_IDS   path to a newline-delimited list of every procedure
 *                           path the index was ever built from; the ids the
 *                           current catalog does not have are deleted
 *
 * Usage (from services/kilo-mcp):
 *   node scripts/embed-catalog.ts ensure-index
 *   node scripts/embed-catalog.ts upsert
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EMBEDDING_DIMENSIONS, EMBEDDING_METRIC, EMBEDDING_MODEL } from '../src/embedding.ts';
import type { Catalog, CatalogRow } from '../src/types.ts';

/** Cloudflare REST API root. */
const API_ROOT = 'https://api.cloudflare.com/client/v4';

/** Rows per AI-embed / Vectorize-upsert request (requirement: batch ≤64). */
export const EMBED_BATCH_SIZE = 64;

/** Ids per delete_by_ids request. */
export const PRUNE_BATCH_SIZE = 100;

/** One upsert record: vector id = procedure path, values = embedding, metadata. */
type UpsertRecord = {
  id: string;
  values: number[];
  metadata: { path: string; kind: string; tags: string[] };
};

type EmbedEnv = {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  VECTORIZE_INDEX_NAME: string;
};

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

type EmbedOptions = EmbedEnv & {
  catalog: Catalog;
  fetchImpl?: FetchLike;
  log?: (message: string) => void;
};

/** Cloudflare REST envelope: `{success, errors, messages, result}`. */
type CfEnvelope = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: unknown;
};

function defaultFetch(): FetchLike {
  return (url, init) => fetch(url, init);
}

async function cfRequest(
  fetchImpl: FetchLike,
  env: EmbedEnv,
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<unknown> {
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  let body: CfEnvelope = {};
  try {
    body = (await response.json()) as CfEnvelope;
  } catch {
    // A non-JSON body is reported through the status check below.
  }
  if (!response.ok || body.success === false) {
    const detail = (body.errors ?? []).map(error => error.message ?? String(error.code)).join('; ');
    throw new CfApiError(
      `Cloudflare API ${init?.method ?? 'GET'} ${path} failed (HTTP ${response.status}): ${detail || 'no error detail'}`,
      response.status
    );
  }
  return body.result;
}

/** Like cfRequest but maps HTTP 404 to null (index lookups). */
async function cfRequestOptional(
  fetchImpl: FetchLike,
  env: EmbedEnv,
  path: string
): Promise<unknown> {
  try {
    return await cfRequest(fetchImpl, env, path);
  } catch (error) {
    if (error instanceof CfApiError && error.status === 404) return null;
    throw error;
  }
}

/** Error carrying the HTTP status of a failed Cloudflare API call. */
export class CfApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CfApiError';
    this.status = status;
  }
}

/**
 * Create the Vectorize index idempotently: GET the index first; when it does
 * not exist (HTTP 404), create it with the pinned dimensions and metric.
 * An existing index is reported and left untouched.
 */
export async function ensureIndex(
  options: EmbedOptions
): Promise<{ created: boolean; indexName: string }> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const log = options.log ?? (() => {});
  const indexName = options.VECTORIZE_INDEX_NAME;

  const existing = await cfRequestOptional(
    fetchImpl,
    options,
    `/accounts/${options.CLOUDFLARE_ACCOUNT_ID}/vectorize/v2/indexes/${indexName}`
  );
  if (existing !== null) {
    log(`✅ index "${indexName}" already exists`);
    return { created: false, indexName };
  }
  await cfRequest(
    fetchImpl,
    options,
    `/accounts/${options.CLOUDFLARE_ACCOUNT_ID}/vectorize/v2/indexes`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: indexName,
        config: { dimensions: EMBEDDING_DIMENSIONS, metric: EMBEDDING_METRIC },
        description: 'Kilo API catalog semantic index (kilo-mcp hybrid search)',
      }),
    }
  );
  log(
    `✅ created index "${indexName}" (dimensions=${EMBEDDING_DIMENSIONS}, metric=${EMBEDDING_METRIC})`
  );
  return { created: true, indexName };
}

/**
 * Embed every catalog row's searchBlob and upsert it into the index.
 * Returns the number of vectors written.
 */
export async function embedAndUpsert(options: EmbedOptions): Promise<{ vectors: number }> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const log = options.log ?? (() => {});

  const rows = Object.values(options.catalog);
  if (rows.length === 0) {
    log('catalog is empty; nothing to embed');
    return { vectors: 0 };
  }

  let vectors = 0;
  for (let start = 0; start < rows.length; start += EMBED_BATCH_SIZE) {
    const batch = rows.slice(start, start + EMBED_BATCH_SIZE);
    const result = (await cfRequest(
      fetchImpl,
      options,
      `/accounts/${options.CLOUDFLARE_ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`,
      { method: 'POST', body: JSON.stringify({ text: batch.map(row => row.searchBlob) }) }
    )) as { data?: number[][] };

    const embeddings = result.data;
    if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
      throw new Error(
        `embedding model ${EMBEDDING_MODEL} returned ${embeddings?.length ?? 'no'} vectors for a batch of ${batch.length}`
      );
    }

    const records: UpsertRecord[] = batch.map((row, index) => ({
      id: row.path,
      values: embeddings[index],
      metadata: { path: row.path, kind: row.kind, tags: row.tags },
    }));
    // Vectorize v2 upsert accepts NDJSON (one record per line).
    const ndjson = records.map(record => JSON.stringify(record)).join('\n');
    const upsert = (await cfRequest(
      fetchImpl,
      options,
      `/accounts/${options.CLOUDFLARE_ACCOUNT_ID}/vectorize/v2/indexes/${options.VECTORIZE_INDEX_NAME}/upsert`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: ndjson }
    )) as { count?: number };
    vectors += upsert.count ?? records.length;
    log(
      `  batch ${Math.floor(start / EMBED_BATCH_SIZE) + 1}/${Math.ceil(rows.length / EMBED_BATCH_SIZE)}: embedded + upserted ${batch.length} vectors`
    );
  }

  log(
    `✅ upserted ${vectors} vectors into "${options.VECTORIZE_INDEX_NAME}" (${rows.length} catalog rows)`
  );
  return { vectors };
}

/**
 * Delete the vectors whose procedure path the current catalog no longer has.
 * The index is otherwise rebuilt by upsert alone, so a removed or renamed
 * procedure would keep a vector that competes for every future kNN slot.
 *
 * `everIndexed` is every path any published catalog carried, not only the
 * previous one: a run whose prune failed would otherwise strand the ids it was
 * meant to delete, because the next run no longer sees them in its base.
 * Deleting an id the index never had is a no-op.
 *
 * The ids come from git history, never from the index itself: listing the whole
 * production index through the REST API times out.
 *
 * An empty current catalog prunes nothing: the dump refuses to write one, so an
 * empty artifact means something went wrong, and emptying the production index
 * on a bad artifact is worse than leaving the stale ids behind.
 */
export async function pruneRemovedPaths(
  options: EmbedOptions,
  everIndexed: readonly string[] | undefined
): Promise<{ deleted: string[] }> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const log = options.log ?? (() => {});
  if (!everIndexed || everIndexed.length === 0) {
    log('no known index ids; nothing to prune');
    return { deleted: [] };
  }
  if (Object.keys(options.catalog).length === 0) {
    log('catalog is empty; skipping the stale-vector prune');
    return { deleted: [] };
  }

  const removed = [...new Set(everIndexed)].filter(path => !(path in options.catalog)).sort();
  if (removed.length === 0) {
    log('✅ no procedure left the catalog; nothing to prune');
    return { deleted: [] };
  }

  for (let start = 0; start < removed.length; start += PRUNE_BATCH_SIZE) {
    const batch = removed.slice(start, start + PRUNE_BATCH_SIZE);
    await cfRequest(
      fetchImpl,
      options,
      `/accounts/${options.CLOUDFLARE_ACCOUNT_ID}/vectorize/v2/indexes/${options.VECTORIZE_INDEX_NAME}/delete_by_ids`,
      { method: 'POST', body: JSON.stringify({ ids: batch }) }
    );
    log(`  pruned ${Math.min(start + PRUNE_BATCH_SIZE, removed.length)}/${removed.length} vectors`);
  }

  log(
    `✅ deleted ${removed.length} vectors for ids the catalog no longer has from "${options.VECTORIZE_INDEX_NAME}"`
  );
  return { deleted: removed };
}

function envFromProcess(): EmbedEnv {
  const missing = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'VECTORIZE_INDEX_NAME'].filter(
    name => !process.env[name]
  );
  if (missing.length > 0) {
    throw new Error(`missing required env: ${missing.join(', ')}`);
  }
  const read = (name: string): string => process.env[name] ?? '';
  return {
    CLOUDFLARE_ACCOUNT_ID: read('CLOUDFLARE_ACCOUNT_ID'),
    CLOUDFLARE_API_TOKEN: read('CLOUDFLARE_API_TOKEN'),
    VECTORIZE_INDEX_NAME: read('VECTORIZE_INDEX_NAME'),
  };
}

function isCatalogRow(value: unknown): value is CatalogRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row['path'] === 'string' &&
    // Closed set: mutations index alongside queries, anything else is drift.
    (row['kind'] === 'query' || row['kind'] === 'mutation') &&
    typeof row['summary'] === 'string' &&
    typeof row['searchBlob'] === 'string' &&
    Array.isArray(row['tags']) &&
    row['tags'].every(tag => typeof tag === 'string') &&
    typeof row['inputSchema'] === 'object' &&
    row['inputSchema'] !== null &&
    !Array.isArray(row['inputSchema'])
  );
}

/** Validate the committed artifact before it reaches Vectorize; fail loudly on drift. */
export function parseCatalog(value: unknown): Catalog {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('catalog.json must be a JSON object keyed by procedure path.');
  }
  const catalog: Catalog = {};
  for (const [key, row] of Object.entries(value as Record<string, unknown>)) {
    if (!isCatalogRow(row) || row.path !== key) {
      throw new Error(`catalog.json entry "${key}" is not a valid catalog row.`);
    }
    catalog[key] = row;
  }
  return catalog;
}

/**
 * The newline-delimited index ids named by `MCP_CATALOG_PRUNE_IDS`, or
 * undefined when the caller cannot supply them (a manual run, or a history
 * walk that failed).
 */
export function loadDeleteCandidates(
  path = process.env['MCP_CATALOG_PRUNE_IDS']
): string[] | undefined {
  if (!path) return undefined;
  return readFileSync(path, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
}

/** Read the committed catalog.json that sits next to this script's package. */
export function loadCatalog(): Catalog {
  // import.meta.url is ALREADY a file URL: decode it with fileURLToPath —
  // pathToFileURL(import.meta.url) double-encodes and yields an ENOENT path.
  const catalogPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'catalog.json');
  return parseCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')) as unknown);
}

async function main(): Promise<void> {
  const env = envFromProcess();
  const options: EmbedOptions = {
    ...env,
    catalog: loadCatalog(),
    log: message => console.log(message),
  };
  const subcommand = process.argv[2];
  if (subcommand === 'ensure-index') {
    await ensureIndex(options);
    return;
  }
  // "upsert" is the explicit name of the default behavior, used by the
  // main-branch merge job so the workflow line reads as what it does.
  if (subcommand !== undefined && subcommand !== 'upsert') {
    throw new Error(
      `unknown subcommand "${subcommand}" (expected "upsert", "ensure-index", or none)`
    );
  }
  await embedAndUpsert(options);
  await pruneRemovedPaths(options, loadDeleteCandidates());
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error('❌', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

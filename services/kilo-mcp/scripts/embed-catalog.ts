/// <reference types="node" />
/**
 * Embed the Kilo catalog and upsert it into Vectorize.
 *
 * Reads services/kilo-mcp/catalog.json, embeds every row's searchBlob via the
 * Cloudflare REST API (Workers AI run endpoint), and upserts the vectors with
 * the procedure path as vector id (requirement 9) and {path, kind, tags} as
 * metadata. Batches at ≤64 rows per request.
 *
 * Subcommands:
 *   (none)|upsert  embed + upsert every catalog row
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
 * Usage (from services/kilo-mcp):
 *   node scripts/embed-catalog.ts ensure-index
 *   node scripts/embed-catalog.ts upsert
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EMBEDDING_DIMENSIONS, EMBEDDING_METRIC, EMBEDDING_MODEL } from '../src/embedding.ts';
import type { Catalog } from '../src/types.ts';

/** Cloudflare REST API root. */
const API_ROOT = 'https://api.cloudflare.com/client/v4';

/** Rows per AI-embed / Vectorize-upsert request (requirement: batch ≤64). */
export const EMBED_BATCH_SIZE = 64;

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

/** Read the committed catalog.json that sits next to this script's package. */
export function loadCatalog(): Catalog {
  // import.meta.url is ALREADY a file URL: decode it with fileURLToPath —
  // pathToFileURL(import.meta.url) double-encodes and yields an ENOENT path.
  const catalogPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'catalog.json');
  return JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog;
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
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error('❌', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

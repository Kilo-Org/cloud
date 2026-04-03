import { z } from 'zod';
import type { WantedItem } from '../dos/wasteland/wanted-cache';

const LOG = '[dolthub-api]';

/** Maximum number of retry attempts for rate-limited or unavailable responses. */
const MAX_RETRIES = 3;

/** Base delay in ms for exponential backoff. */
const BASE_DELAY_MS = 1000;

/**
 * Zod schema for a single row returned by the DoltHub SQL API.
 * Uses passthrough so unknown columns don't cause parse failures.
 */
const DoltHubWantedRow = z
  .object({
    item_id: z.string(),
    title: z.string(),
    description: z.string().nullable().default(null),
    bounty: z.coerce.number().nullable().default(null),
    status: z.string().default('open'),
    claimed_by: z.string().nullable().default(null),
    claim_id: z.string().nullable().default(null),
    evidence: z.string().nullable().default(null),
    created_at: z.string().nullable().default(null),
    updated_at: z.string().nullable().default(null),
  })
  .passthrough();

/**
 * Zod schema for the DoltHub SQL API response envelope.
 * The API returns `{ query_execution_status: string, query_execution_message: string, rows: [...], schema: [...] }`.
 */
const DoltHubQueryResponse = z.object({
  query_execution_status: z.string(),
  query_execution_message: z.string().optional(),
  rows: z.array(z.record(z.string(), z.unknown())),
  schema: z.array(z.unknown()).optional(),
});

/**
 * Parse a DoltHub upstream string like "owner/repo" or "owner/repo/branch"
 * into its components. Defaults branch to "main".
 */
function parseUpstream(upstream: string): {
  owner: string;
  repo: string;
  branch: string;
} {
  const parts = upstream.split('/');
  if (parts.length < 2) {
    throw new Error(`Invalid dolthub_upstream format: "${upstream}" (expected "owner/repo" or "owner/repo/branch")`);
  }
  return {
    owner: parts[0],
    repo: parts[1],
    branch: parts[2] ?? 'main',
  };
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch the wanted board from DoltHub SQL API.
 *
 * Uses POST https://www.dolthub.com/api/v1alpha1/{owner}/{repo}/{branch}/query
 * with SQL: SELECT * FROM wanted ORDER BY created_at DESC
 *
 * Handles:
 * - 429 (rate limited): exponential backoff with retry
 * - 503 (DoltHub downtime): exponential backoff with retry
 * - Non-200: throws with status info
 */
export async function fetchWantedBoard(
  upstream: string,
  token?: string
): Promise<WantedItem[]> {
  const { owner, repo, branch } = parseUpstream(upstream);
  const url = `https://www.dolthub.com/api/v1alpha1/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/query`;
  const sqlQuery = 'SELECT * FROM wanted ORDER BY created_at DESC';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`${LOG} retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
      await sleep(delay);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ q: sqlQuery }),
      });
    } catch (err) {
      lastError =
        err instanceof Error ? err : new Error(String(err));
      console.error(`${LOG} fetch failed (attempt ${attempt}):`, lastError.message);
      continue;
    }

    if (res.status === 429) {
      console.warn(`${LOG} rate limited (429), will retry`);
      lastError = new Error('DoltHub rate limited (429)');
      continue;
    }

    if (res.status === 503) {
      console.warn(`${LOG} DoltHub unavailable (503), will retry`);
      lastError = new Error('DoltHub unavailable (503)');
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `DoltHub API error: ${res.status} ${res.statusText} — ${body}`
      );
    }

    const json: unknown = await res.json();
    const parsed = DoltHubQueryResponse.parse(json);

    if (parsed.query_execution_status !== 'Success') {
      throw new Error(
        `DoltHub query failed: ${parsed.query_execution_status} — ${parsed.query_execution_message ?? 'unknown error'}`
      );
    }

    return parsed.rows.map(row => DoltHubWantedRow.parse(row));
  }

  throw lastError ?? new Error('fetchWantedBoard exhausted retries');
}

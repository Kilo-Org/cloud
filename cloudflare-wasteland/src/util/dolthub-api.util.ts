import { z } from 'zod';
import type { WantedItem } from '../dos/wasteland/wanted-cache';

/**
 * DoltHub SQL API client for polling the wanted board.
 *
 * Uses the DoltHub v1alpha1 query endpoint:
 *   POST https://www.dolthub.com/api/v1alpha1/{owner}/{repo}/{branch}/query
 *
 * The `upstream` string format is `owner/repo` or `owner/repo/branch`.
 * If no branch is specified, defaults to `main`.
 */

const DOLTHUB_API_BASE = 'https://www.dolthub.com/api/v1alpha1';
const DEFAULT_BRANCH = 'main';
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000;

// ── DoltHub response schema ─────────────────────────────────────────────

const DoltHubColumnSchema = z.object({
  columnName: z.string(),
  columnType: z.string(),
});

const DoltHubQueryResponseSchema = z.object({
  query_execution_status: z.string(),
  query_execution_message: z.string().optional(),
  schema: z.array(DoltHubColumnSchema).optional(),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
});

/**
 * Maps a DoltHub row (column-name → value) to our WantedItem shape.
 * DoltHub returns column names matching the Dolt table schema.
 */
const DoltHubWantedRowSchema = z
  .object({
    item_id: z.string(),
    title: z.string(),
    description: z.string().nullish(),
    bounty: z.coerce.number().int().nullish(),
    status: z.string().nullish(),
    claimed_by: z.string().nullish(),
    claim_id: z.string().nullish(),
    evidence: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .transform(
    (row): WantedItem => ({
      item_id: row.item_id,
      title: row.title,
      description: row.description ?? null,
      bounty: row.bounty ?? null,
      status: row.status ?? null,
      claimed_by: row.claimed_by ?? null,
      claim_id: row.claim_id ?? null,
      evidence: row.evidence ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    })
  );

// ── Helpers ─────────────────────────────────────────────────────────────

function parseUpstream(upstream: string): { owner: string; repo: string; branch: string } {
  const parts = upstream.split('/');
  if (parts.length < 2) {
    throw new DoltHubApiError(`Invalid upstream format: "${upstream}". Expected "owner/repo" or "owner/repo/branch".`);
  }
  return {
    owner: parts[0],
    repo: parts[1],
    branch: parts[2] ?? DEFAULT_BRANCH,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Errors ──────────────────────────────────────────────────────────────

export class DoltHubApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'DoltHubApiError';
  }
}

// ── Main fetch function ─────────────────────────────────────────────────

/**
 * Polls DoltHub for the wanted board contents.
 *
 * Handles:
 * - 429 (rate limiting) with exponential backoff
 * - 503 (DoltHub downtime) with retry
 * - Non-200 responses as errors
 */
export async function fetchWantedBoard(
  upstream: string,
  token?: string
): Promise<WantedItem[]> {
  const { owner, repo, branch } = parseUpstream(upstream);
  const url = `${DOLTHUB_API_BASE}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/query`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const body = JSON.stringify({
    query: 'SELECT * FROM wanted ORDER BY created_at DESC',
  });

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
      await sleep(backoffMs);
    }

    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[dolthub-api] fetch attempt ${attempt + 1}/${MAX_RETRIES} failed: ${lastError.message}`);
      continue;
    }

    if (response.status === 429) {
      console.warn(`[dolthub-api] rate limited (429), retrying (attempt ${attempt + 1}/${MAX_RETRIES})`);
      lastError = new DoltHubApiError('DoltHub rate limit exceeded', 429, true);
      continue;
    }

    if (response.status === 503) {
      console.warn(`[dolthub-api] DoltHub unavailable (503), retrying (attempt ${attempt + 1}/${MAX_RETRIES})`);
      lastError = new DoltHubApiError('DoltHub unavailable', 503, true);
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new DoltHubApiError(
        `DoltHub API error: ${response.status} ${response.statusText} — ${text}`,
        response.status
      );
    }

    const rawJson: unknown = await response.json();
    const parsed = DoltHubQueryResponseSchema.parse(rawJson);

    if (parsed.query_execution_status !== 'Success') {
      throw new DoltHubApiError(
        `DoltHub query failed: ${parsed.query_execution_message ?? 'unknown error'}`
      );
    }

    const rows = parsed.rows ?? [];
    return rows.map(row => DoltHubWantedRowSchema.parse(row));
  }

  throw lastError ?? new DoltHubApiError('DoltHub API request failed after retries');
}

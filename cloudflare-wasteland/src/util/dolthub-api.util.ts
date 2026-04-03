/**
 * DoltHub REST API client for polling wanted board state.
 *
 * Uses the DoltHub SQL API to run queries against the wasteland's
 * upstream Dolt repository, then parses results with Zod.
 */
import { z } from 'zod';
import type { WantedItem } from '../dos/wasteland/wanted-cache';

const LOG = '[dolthub-api]';

/**
 * Parse an upstream string like "owner/repo" or "owner/repo/branch"
 * into its constituent parts. Defaults branch to "main" if omitted.
 */
function parseUpstream(upstream: string): { owner: string; repo: string; branch: string } {
  const parts = upstream.split('/');
  if (parts.length < 2) {
    throw new Error(
      `Invalid upstream format: ${upstream} (expected "owner/repo" or "owner/repo/branch")`
    );
  }
  return {
    owner: parts[0],
    repo: parts[1],
    branch: parts[2] ?? 'main',
  };
}

/** Zod schema for a single row returned by the DoltHub SQL API. */
const DoltHubWantedRow = z.object({
  item_id: z.string(),
  title: z.string(),
  description: z.string().nullable().default(null),
  bounty: z.coerce.number().nullable().default(null),
  status: z.enum(['open', 'claimed', 'done']).default('open'),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  type: z.enum(['feature', 'bug', 'docs', 'other']).default('other'),
  claimed_by: z.string().nullable().default(null),
  claim_id: z.string().nullable().default(null),
  evidence: z.string().nullable().default(null),
  created_at: z.string().nullable().default(null),
  updated_at: z.string().nullable().default(null),
});

/**
 * DoltHub SQL API response shape.
 * The API returns `{ query_execution_status: string, query_execution_message: string,
 *   rows: Array<Record<string, unknown>>, schema: ... }`.
 */
const DoltHubQueryResponse = z.object({
  query_execution_status: z.string(),
  query_execution_message: z.string().optional(),
  rows: z.array(z.record(z.string(), z.unknown())).default([]),
});

/** Maximum number of retry attempts for transient errors. */
const MAX_RETRIES = 3;

/** Base delay (ms) for exponential backoff. */
const BASE_DELAY_MS = 1000;

/**
 * Fetch the wanted board from DoltHub's SQL API.
 *
 * @param upstream - DoltHub upstream in "owner/repo" or "owner/repo/branch" format
 * @param token - Optional DoltHub API token for private repos
 * @returns Parsed wanted items
 */
export async function fetchWantedBoard(upstream: string, token?: string): Promise<WantedItem[]> {
  const { owner, repo, branch } = parseUpstream(upstream);
  const url = `https://www.dolthub.com/api/v1alpha1/${owner}/${repo}/${branch}/query`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          q: 'SELECT * FROM wanted ORDER BY created_at DESC',
        }),
      });

      if (response.status === 429) {
        // Rate limited — back off exponentially
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `${LOG} rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
        );
        await sleep(delay);
        continue;
      }

      if (response.status === 503) {
        // DoltHub downtime — back off
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `${LOG} DoltHub unavailable (503), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
        );
        await sleep(delay);
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`DoltHub API error ${response.status}: ${body || response.statusText}`);
      }

      const json: unknown = await response.json();
      const parsed = DoltHubQueryResponse.parse(json);

      if (parsed.query_execution_status !== 'Success') {
        throw new Error(
          `DoltHub query failed: ${parsed.query_execution_message ?? parsed.query_execution_status}`
        );
      }

      return parsed.rows.map(row => DoltHubWantedRow.parse(row));
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Only retry on network-level errors, not on parse/validation errors
      if (
        lastError.message.includes('DoltHub API error 429') ||
        lastError.message.includes('DoltHub unavailable') ||
        lastError.message.includes('fetch failed')
      ) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`${LOG} transient error, retrying in ${delay}ms:`, lastError.message);
        await sleep(delay);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error(`${LOG} exhausted retries`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

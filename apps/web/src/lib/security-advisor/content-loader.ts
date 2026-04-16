import { readDb } from '@/lib/drizzle';
import {
  security_advisor_check_catalog,
  security_advisor_kiloclaw_coverage,
  security_advisor_content,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { FindingSeverity } from './schemas';

// --- In-memory content types ---

/** One row in the check catalog — server-authoritative copy for a known checkId. */
export type CatalogCheck = {
  severity: FindingSeverity;
  explanation: string;
  risk: string;
};

/** One row in KiloClaw coverage — how KiloClaw handles a security area. */
export type KiloClawCoverageArea = {
  area: string;
  summary: string;
  detail: string;
  matchCheckIds: string[];
};

/**
 * All customer-visible content for the security advisor, loaded from the DB
 * and cached in-process with a TTL.
 *
 * - `checkCatalog`: server-authoritative severity/explanation/risk per known
 *   `checkId`. Overrides what the client reports for findings in the catalog.
 * - `kiloclawCoverage`: how KiloClaw handles each security area, with the
 *   `checkId` → area mapping.
 * - `content`: flat key/value store for CTA, framing templates, and fallback
 *   strings (the six Tier-1 editable pieces of copy).
 */
export type LoadedSecurityAdvisorContent = {
  checkCatalog: Map<string, CatalogCheck>;
  kiloclawCoverage: KiloClawCoverageArea[];
  content: Map<string, string>;
};

// --- TTL cache ---

// 5 minutes in prod; 0 in dev so content changes are visible immediately.
const CACHE_TTL_MS = process.env.NODE_ENV === 'development' ? 0 : 5 * 60 * 1000;

let cached: { data: LoadedSecurityAdvisorContent; expiresAt: number } | null = null;

const EMPTY_CONTENT: LoadedSecurityAdvisorContent = {
  checkCatalog: new Map(),
  kiloclawCoverage: [],
  content: new Map(),
};

/**
 * Load security advisor content from the DB, served from an in-process TTL cache.
 *
 * Uses the read replica. Falls back to empty maps/arrays if the DB is unreachable,
 * so the report generator can still produce output (using client-reported values and
 * missing coverage text) rather than failing the whole request.
 */
export async function getSecurityAdvisorContent(): Promise<LoadedSecurityAdvisorContent> {
  const now = Date.now();
  if (cached !== null && now < cached.expiresAt) {
    return cached.data;
  }
  try {
    const data = await loadFromDb();
    cached = { data, expiresAt: now + CACHE_TTL_MS };
    return data;
  } catch (err) {
    // Degrade gracefully on transient DB failures (e.g. read replica blip).
    // The report generator uses client-reported values for findings and omits
    // coverage text when the loader returns empty, so the request still
    // succeeds — just without server-overridden copy.
    // Intentionally NOT caching the empty result, so the next request retries.
    console.error('[SecurityAdvisor] content-loader failed; returning empty content', err);
    return EMPTY_CONTENT;
  }
}

/** Invalidate the in-process cache, forcing the next call to re-query. */
export function invalidateSecurityAdvisorContentCache(): void {
  cached = null;
}

async function loadFromDb(): Promise<LoadedSecurityAdvisorContent> {
  const [catalogRows, coverageRows, contentRows] = await Promise.all([
    readDb
      .select({
        check_id: security_advisor_check_catalog.check_id,
        severity: security_advisor_check_catalog.severity,
        explanation: security_advisor_check_catalog.explanation,
        risk: security_advisor_check_catalog.risk,
      })
      .from(security_advisor_check_catalog)
      .where(eq(security_advisor_check_catalog.is_active, true)),

    readDb
      .select({
        area: security_advisor_kiloclaw_coverage.area,
        summary: security_advisor_kiloclaw_coverage.summary,
        detail: security_advisor_kiloclaw_coverage.detail,
        match_check_ids: security_advisor_kiloclaw_coverage.match_check_ids,
      })
      .from(security_advisor_kiloclaw_coverage)
      .where(eq(security_advisor_kiloclaw_coverage.is_active, true)),

    readDb
      .select({
        key: security_advisor_content.key,
        value: security_advisor_content.value,
      })
      .from(security_advisor_content)
      .where(eq(security_advisor_content.is_active, true)),
  ]);

  const checkCatalog = new Map<string, CatalogCheck>();
  for (const row of catalogRows) {
    // Validate that severity is one of the known values; skip rows with invalid data
    // rather than letting an invalid DB value crash the report generator.
    if (row.severity === 'critical' || row.severity === 'warn' || row.severity === 'info') {
      checkCatalog.set(row.check_id, {
        severity: row.severity,
        explanation: row.explanation,
        risk: row.risk,
      });
    }
  }

  const kiloclawCoverage: KiloClawCoverageArea[] = coverageRows.map(row => ({
    area: row.area,
    summary: row.summary,
    detail: row.detail,
    matchCheckIds: row.match_check_ids,
  }));

  const content = new Map<string, string>();
  for (const row of contentRows) {
    content.set(row.key, row.value);
  }

  return { checkCatalog, kiloclawCoverage, content };
}

/**
 * Find the KiloClaw coverage entry that covers a given checkId.
 * Returns null if no active coverage entry covers this checkId.
 *
 * Each `checkId` is expected to be covered by at most one area — the admin
 * UI's convention is one-area-per-check. The DB schema doesn't enforce this
 * (match_check_ids is a per-row array), so if an admin accidentally lists
 * the same checkId under multiple active areas we pick deterministically:
 * sort by `area` alphabetically, and log a warning so the duplicate can be
 * found and resolved. Without this, row-insertion-order would decide which
 * coverage shows up in the report, silently flipping between entries.
 */
export function findCoverageForCheckId(
  checkId: string,
  areas: KiloClawCoverageArea[]
): KiloClawCoverageArea | null {
  const matches = areas.filter(a => a.matchCheckIds.includes(checkId));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.warn(
      `[SecurityAdvisor] checkId "${checkId}" is covered by ${matches.length} active areas: ${matches
        .map(a => a.area)
        .join(
          ', '
        )}. Picking the alphabetically-first area for determinism. Resolve the overlap in the admin UI.`
    );
  }
  matches.sort((a, b) => a.area.localeCompare(b.area));
  return matches[0] ?? null;
}

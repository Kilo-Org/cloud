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
 * All customer-visible content for shell security, loaded from the DB
 * and cached in-process with a TTL.
 *
 * - `checkCatalog`: server-authoritative severity/explanation/risk per known
 *   `checkId`. Overrides what the client reports for findings in the catalog.
 * - `kiloclawCoverage`: how KiloClaw handles each security area, with the
 *   `checkId` → area mapping.
 * - `content`: flat key/value store for CTA, framing templates, and fallback
 *   strings (the six Tier-1 editable pieces of copy).
 */
export type LoadedShellSecurityContent = {
  checkCatalog: Map<string, CatalogCheck>;
  kiloclawCoverage: KiloClawCoverageArea[];
  content: Map<string, string>;
};

// --- TTL cache ---

// 5 minutes in prod; 0 in dev so content changes are visible immediately.
// A 0-TTL doesn't disable caching entirely — requests within the same event
// loop tick still coalesce onto the same singleflight promise — but any call
// arriving after a resolved load will find cached.expiresAt <= now and
// re-query. That's the intended dev behavior.
const CACHE_TTL_MS = process.env.NODE_ENV === 'development' ? 0 : 5 * 60 * 1000;

let cached: { data: LoadedShellSecurityContent; expiresAt: number } | null = null;

// Singleflight: when the cache is expired, the first request starts a DB load
// and stashes its promise here. Subsequent requests that arrive before the
// load resolves await the same promise instead of kicking off their own
// parallel query. Without this, a burst of requests right after expiry would
// each fire its own loadFromDb().
let inFlight: Promise<LoadedShellSecurityContent> | null = null;

// Version counter bumped on every invalidation. A load captures the version
// when it starts; if the version changes before the load resolves (because
// an admin save happened mid-load), the result is still returned to the
// caller but is NOT written into `cached` — so the next request re-queries
// and picks up the fresh DB state instead of re-seating pre-save data.
let cacheVersion = 0;

/**
 * Fresh empty content for the degraded-fallback path. Returned as a new
 * object on every call so a downstream caller that accidentally mutates
 * the Maps or arrays can't corrupt a shared singleton.
 */
function emptyContent(): LoadedShellSecurityContent {
  return {
    checkCatalog: new Map(),
    kiloclawCoverage: [],
    content: new Map(),
  };
}

/**
 * Load shell security content from the DB, served from an in-process TTL cache.
 *
 * Uses the read replica. Falls back to empty maps/arrays if the DB is unreachable,
 * so the report generator can still produce output (using client-reported values and
 * missing coverage text) rather than failing the whole request.
 *
 * Concurrent requests after cache expiry are coalesced onto a single in-flight
 * DB load via `inFlight` (singleflight pattern) so a burst never fans out
 * into N parallel queries.
 */
export async function getShellSecurityContent(): Promise<LoadedShellSecurityContent> {
  const now = Date.now();
  if (cached !== null && now < cached.expiresAt) {
    return cached.data;
  }
  if (inFlight !== null) {
    return inFlight;
  }
  const startVersion = cacheVersion;
  const thisLoad: Promise<LoadedShellSecurityContent> = (async () => {
    try {
      const data = await loadFromDb();
      // Only write back to `cached` if no invalidation happened while we
      // were loading. If it did, a newer write has landed in the DB that
      // this load didn't see — caching our result would re-seat stale
      // content for a full TTL. Still return `data` to this caller; the
      // next request will re-query and pick up the fresh state.
      if (cacheVersion === startVersion) {
        cached = { data, expiresAt: Date.now() + CACHE_TTL_MS };
      }
      return data;
    } catch (err) {
      // Degrade gracefully on transient DB failures (e.g. read replica blip).
      // The report generator uses client-reported values for findings and omits
      // coverage text when the loader returns empty, so the request still
      // succeeds — just without server-overridden copy.
      // Intentionally NOT caching the empty result, so the next request retries.
      console.error('[ShellSecurity] content-loader failed; returning empty content', err);
      return emptyContent();
    }
  })();
  inFlight = thisLoad;
  // Clear inFlight only if it still points at THIS load. If an invalidation
  // happened mid-load, a newer load may have replaced inFlight; clearing it
  // unconditionally would wipe the newer load and let subsequent callers
  // fan out into extra parallel queries. Attached as a chained .finally
  // rather than inside the IIFE so `thisLoad` is definitely assigned by the
  // time the callback reads it (avoids TS2454 self-reference).
  void thisLoad.finally(() => {
    if (inFlight === thisLoad) {
      inFlight = null;
    }
  });
  return thisLoad;
}

/** Invalidate the in-process cache, forcing the next call to re-query.
 *
 * We also clear `inFlight` and bump `cacheVersion`. This has one intentional
 * cost: an in-flight pre-write load keeps running to completion (we can't
 * cancel it) — so a caller arriving between invalidation and the post-write
 * load starting WILL launch a second parallel query. Both loads run
 * concurrently for a moment; the older one's result is discarded by the
 * cacheVersion check, and its `finally` block leaves inFlight alone
 * because it no longer points at itself. Benign, no stale-cache risk.
 *
 * Also clears `inFlight` so a new request after invalidation starts a
 * fresh DB load (rather than coalescing onto a pre-write load whose
 * result is about to be discarded by the cacheVersion check). */
export function invalidateShellSecurityContentCache(): void {
  cached = null;
  inFlight = null;
  cacheVersion++;
}

// The `security_advisor_*` DB tables deliberately keep their pre-rename names.
// The shell-security rebrand covers server code and public surfaces, but
// renaming the tables would require a migration with zero functional payoff —
// and would break existing PostHog/Metabase dashboards keyed on the table
// names. Expect this naming asymmetry between the module and the tables to
// remain permanent unless a future migration retires `security_advisor_*`.
async function loadFromDb(): Promise<LoadedShellSecurityContent> {
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
    // rather than letting an invalid DB value crash the report generator. The DB
    // CHECK constraint should prevent this, so a skip here is a signal that
    // something has gone wrong (bad seed, manual SQL edit, etc.) — log the
    // check_id so an operator can find and fix the bad row.
    if (row.severity === 'critical' || row.severity === 'warn' || row.severity === 'info') {
      checkCatalog.set(row.check_id, {
        severity: row.severity,
        explanation: row.explanation,
        risk: row.risk,
      });
    } else {
      console.warn(
        `[ShellSecurity] skipping check_id="${row.check_id}" with invalid severity="${row.severity}". Valid values: critical, warn, info.`
      );
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
      `[ShellSecurity] checkId "${checkId}" is covered by ${matches.length} active areas: ${matches
        .map(a => a.area)
        .join(
          ', '
        )}. Picking the alphabetically-first area for determinism. Resolve the overlap in the admin UI.`
    );
  }
  matches.sort((a, b) => a.area.localeCompare(b.area));
  return matches[0] ?? null;
}

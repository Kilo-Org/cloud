import { createHash } from 'node:crypto';
import {
  scanRequest,
  type EnkryptDetectDependencies,
  type EnkryptGuardrailScan,
  type EnkryptGuardrailScanResult,
  type EnkryptScanCoverage,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import { joinRequestSegments } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';
import type { EnkryptInputGuardrailConfig } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/** When false, every request is scanned in full. */
export const ENKRYPT_VERDICT_CACHE_ENABLED = true;

/**
 * Bump when key derivation or the meaning of an allowed verdict changes, for example how detector
 * results are parsed or which detections block, so entries written by older code stop matching.
 * Extraction changes already change the hashed segments.
 */
const VERDICT_CACHE_VERSION = 1;

export const ENKRYPT_VERDICT_CACHE_TTL_SECONDS = 6 * 60 * 60;

/**
 * Already-scanned text sent ahead of the uncached suffix, so content split across the boundary is
 * still scanned together. Context-dependent detection further back is not re-evaluated.
 */
export const ENKRYPT_SCAN_OVERLAP_CHARACTERS = 2_000;

/**
 * Bounds the lookup. Cached prefixes are earlier requests of the same conversation, which end near
 * the end of the current one.
 */
export const MAX_PROBED_PREFIXES = 128;

export type EnkryptVerdictCacheStore = {
  mget(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, options: { ex: number }): Promise<unknown>;
};

export type EnkryptGuardrailRequest = Omit<EnkryptGuardrailScan, 'text' | 'coverage'> & {
  segments: string[];
};

export type EnkryptCachedScanResult = Omit<EnkryptGuardrailScanResult, 'report'> & {
  /** Null when no scan ran. */
  report: EnkryptGuardrailScanResult['report'] | null;
  /** Set when the request was allowed and its full content is not cached yet. */
  allowedKey: string | null;
};

type ReadyConfig = Extract<EnkryptInputGuardrailConfig, { status: 'ready' }>;

function configHash(config: ReadyConfig): Buffer {
  return createHash('sha256')
    .update(
      JSON.stringify({
        detectors: config.detectors,
        blockingDetectors: [...config.blockingDetectors].sort(),
        scanToolResults: config.scanToolResults,
      })
    )
    .digest();
}

/**
 * One key per segment, each covering the exact ordered content up to and including that segment:
 * `h_0` hashes the scope, and `h_i = sha256(h_{i-1} || length || segment_i)`. Editing, removing,
 * or reordering any segment changes the keys of every later one, so a client that rewrites history
 * never inherits an earlier verdict. Segments are hashed as UTF-16 code units to stay exact for
 * lone surrogates, which UTF-8 would replace.
 *
 * The scope includes the user, so scan latency cannot reveal whether another member of the
 * organization sent the same content.
 */
export function verdictCacheKeys(
  { organizationId, kiloUserId }: Pick<EnkryptGuardrailRequest, 'organizationId' | 'kiloUserId'>,
  config: ReadyConfig,
  segments: string[]
): string[] {
  const keyPrefix = `enkrypt-guardrail:verdict:v${VERDICT_CACHE_VERSION}:${organizationId}:`;
  let chain = createHash('sha256')
    .update(`${keyPrefix}${kiloUserId.length}:`)
    .update(kiloUserId, 'utf16le')
    .update(configHash(config))
    .digest();
  return segments.map(segment => {
    chain = createHash('sha256')
      .update(chain)
      .update(`${segment.length}:`)
      .update(segment, 'utf16le')
      .digest();
    return `${keyPrefix}${chain.toString('hex')}`;
  });
}

async function cachedSegmentCount(
  organizationId: string,
  keys: string[],
  store: EnkryptVerdictCacheStore
): Promise<number | 'error'> {
  const firstProbed = Math.max(0, keys.length - MAX_PROBED_PREFIXES);
  try {
    const values = await store.mget(keys.slice(firstProbed));
    const lastCached = values.findLastIndex(value => value !== null);
    return lastCached === -1 ? 0 : firstProbed + lastCached + 1;
  } catch (error) {
    warnExceptInTest('[enkrypt-guardrail] verdict cache lookup failed; scanning in full', {
      organization_id: organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'error';
  }
}

/**
 * A log-only scan also allows when it fails or the text is too large to send, so only an allow
 * that Enkrypt itself decided on its final call is cached.
 */
function enkryptAllowed({ verdict, usageRecords }: EnkryptGuardrailScanResult): boolean {
  return verdict.action === 'allow' && usageRecords.at(-1)?.decision === 'allowed';
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** Never starts between the two halves of a surrogate pair. */
function overlapStart(text: string, cachedCharacters: number): number {
  const start = Math.max(0, cachedCharacters - ENKRYPT_SCAN_OVERLAP_CHARACTERS);
  return start > 0 && isLowSurrogate(text.charCodeAt(start)) ? start - 1 : start;
}

/**
 * Scans only the part of the request that no earlier allowed request with the same scope covered,
 * plus an overlap. A cache failure scans the request in full, so it never lets unscanned content
 * through.
 */
export async function scanRequestWithVerdictCache(
  { segments, ...request }: EnkryptGuardrailRequest,
  deps: EnkryptDetectDependencies & { store: EnkryptVerdictCacheStore | null }
): Promise<EnkryptCachedScanResult> {
  const text = joinRequestSegments(segments);
  const uncached: EnkryptScanCoverage = {
    cache: 'off',
    totalCharacters: text.length,
    totalSegments: segments.length,
    cachedCharacters: 0,
    cachedSegments: 0,
  };
  const { config } = request;
  if (!deps.store || config.status !== 'ready' || segments.length === 0) {
    const result = await scanRequest({ ...request, text, coverage: uncached }, deps);
    return { ...result, allowedKey: null };
  }

  const keys = verdictCacheKeys(request, config, segments);
  const lookup = await cachedSegmentCount(request.organizationId, keys, deps.store);
  const cachedSegments = lookup === 'error' ? 0 : lookup;
  const cachedCharacters = joinRequestSegments(segments.slice(0, cachedSegments)).length;
  const fullyCached = cachedSegments === segments.length;
  const coverage: EnkryptScanCoverage = {
    ...uncached,
    cache: lookup === 'error' ? 'error' : cachedSegments > 0 ? 'hit' : 'miss',
    cachedCharacters,
    cachedSegments,
  };
  const scannedText = fullyCached ? '' : text.slice(overlapStart(text, cachedCharacters));

  const result = await scanRequest({ ...request, text: scannedText, coverage }, deps);
  const allowedKey = !fullyCached && enkryptAllowed(result) ? (keys.at(-1) ?? null) : null;
  return { ...result, allowedKey };
}

/** Returns whether the entry was stored. */
export async function rememberAllowedRequest(
  key: string,
  store: EnkryptVerdictCacheStore
): Promise<boolean> {
  try {
    await store.set(key, '1', { ex: ENKRYPT_VERDICT_CACHE_TTL_SECONDS });
    return true;
  } catch (error) {
    warnExceptInTest('[enkrypt-guardrail] verdict cache write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

import { createHash } from 'node:crypto';
import * as z from 'zod';
import { ENKRYPT_DETECTOR_IDS } from '@kilocode/db/schema-types';
import {
  ENKRYPT_MAX_SCAN_CHARACTERS,
  guardrailBlockMessage,
  scanRequest,
  type EnkryptDetectDependencies,
  type EnkryptGuardrailScan,
  type EnkryptGuardrailScanResult,
  type EnkryptScanCoverage,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import {
  joinRequestSegments,
  sourceAlignedStart,
  sourceHeader,
  userMessageTextsBefore,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';
import type { EnkryptInputGuardrailConfig } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import type { EnkryptGuardrailReport } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/** When false, every request is scanned in full. */
export const ENKRYPT_VERDICT_CACHE_ENABLED = true;

/**
 * Bump when key derivation or the meaning of a cached verdict changes, for example how detector
 * results are parsed, which detections block, or which context a scan of the uncached suffix
 * includes, so entries written by older code stop matching. Extraction changes already change the
 * hashed segments.
 */
const VERDICT_CACHE_VERSION = 3;

export const ENKRYPT_VERDICT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Already-scanned text always sent ahead of the uncached suffix, so content split across the
 * boundary is still scanned together. Only this much context can make a scan exceed
 * `ENKRYPT_MAX_SCAN_CHARACTERS`; the rest is added only while the scan stays small.
 */
export const ENKRYPT_MIN_SCAN_OVERLAP_CHARACTERS = 2_000;

/**
 * The overlap grows up to this, so the action and result just before the uncached suffix, such as a
 * read followed by a send, are usually scanned whole. It starts at a source header when one is in
 * range, and otherwise repeats the header of the source it starts inside.
 */
export const ENKRYPT_MAX_SCAN_OVERLAP_CHARACTERS = 8_000;

/**
 * Context beyond the minimum overlap, meaning the longer overlap and carried user messages, only
 * fills a scan up to this size and never grows a larger one. Scan latency rises with size and the
 * shared deadline does not, so the extra context is kept to scans that are small anyway.
 */
export const ENKRYPT_CONTEXT_SCAN_CHARACTERS = 25_000;

/**
 * Policy rules can depend on what the user asked for, such as whether a transfer was requested,
 * which is usually far behind the uncached suffix. Up to this much of the first and the latest
 * earlier user message is carried ahead of the overlap of a policy scan.
 */
export const ENKRYPT_MAX_CARRIED_USER_CHARACTERS = 4_000;

/** A carried excerpt shorter than this is too short to say what was asked. */
const MIN_CARRIED_USER_CHARACTERS = 200;

/**
 * Bounds the lookup. Cached prefixes are earlier requests of the same conversation, which end near
 * the end of the current one.
 */
export const MAX_PROBED_PREFIXES = 1_024;

const cachedBlockVerdictSchema = z
  .object({
    action: z.literal('block'),
    detectors: z.array(z.enum(ENKRYPT_DETECTOR_IDS)).nonempty(),
  })
  .strict();

export type EnkryptVerdictCacheEntry = {
  key: string;
  verdict: 'allow' | z.infer<typeof cachedBlockVerdictSchema>;
};

export type EnkryptVerdictCacheStore = {
  mget(keys: string[]): Promise<unknown[]>;
  set(
    key: string,
    value: EnkryptVerdictCacheEntry['verdict'],
    options: { ex: number } & ({ nx: true } | { nx?: never })
  ): Promise<unknown>;
};

export type EnkryptGuardrailRequest = Omit<EnkryptGuardrailScan, 'text' | 'coverage'> & {
  segments: string[];
};

export type EnkryptCachedScanResult = Omit<EnkryptGuardrailScanResult, 'report'> & {
  /** Null when no scan ran. */
  report: EnkryptGuardrailScanResult['report'] | null;
  cacheEntry: EnkryptVerdictCacheEntry | null;
};

type ReadyConfig = Extract<EnkryptInputGuardrailConfig, { status: 'ready' }>;

function configHash(config: ReadyConfig): Buffer {
  return createHash('sha256')
    .update(
      JSON.stringify({
        detectors: config.detectors,
        blockingDetectors: [...config.blockingDetectors].sort(),
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

async function cachedPrefix(
  organizationId: string,
  keys: string[],
  config: ReadyConfig,
  store: EnkryptVerdictCacheStore
): Promise<{ cachedSegments: number; verdict: EnkryptVerdictCacheEntry['verdict'] } | 'error'> {
  const firstProbed = Math.max(0, keys.length - MAX_PROBED_PREFIXES);
  try {
    const values = await store.mget(keys.slice(firstProbed));
    let cachedSegments = 0;
    for (const [index, value] of values.entries()) {
      const segments = firstProbed + index + 1;
      if (value === 'allow') {
        cachedSegments = segments;
        continue;
      }
      let parsed: unknown = value;
      if (typeof value === 'string') {
        try {
          parsed = JSON.parse(value);
        } catch {
          continue;
        }
      }
      const blocked = cachedBlockVerdictSchema.safeParse(parsed);
      if (
        blocked.success &&
        blocked.data.detectors.every(detector => config.blockingDetectors.includes(detector))
      ) {
        return { cachedSegments: segments, verdict: blocked.data };
      }
    }
    return { cachedSegments, verdict: 'allow' };
  } catch (error) {
    warnExceptInTest('[enkrypt-guardrail] verdict cache lookup failed; scanning in full', {
      organization_id: organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'error';
  }
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** Never splits a surrogate pair. */
function codePointBoundary(text: string, index: number): number {
  return index > 0 && index < text.length && isLowSurrogate(text.charCodeAt(index))
    ? index - 1
    : index;
}

function excerpt(text: string, maxCharacters: number): string {
  return text.length <= maxCharacters
    ? text
    : text.slice(0, codePointBoundary(text, maxCharacters));
}

/**
 * The first and the latest user message that end before `start`, each shortened to its share of
 * `budget`, with headers saying they are earlier, already-scanned messages. Their sources come from
 * headers the gateway wrote, so text inside a tool result cannot be carried as a user message.
 */
function carriedUserMessages(text: string, start: number, budget: number): string {
  const earlier = userMessageTextsBefore(text, start);
  const carried = earlier.length > 1 ? [earlier[0], earlier[earlier.length - 1]] : earlier;
  const separators = '\n\n'.length * (carried.length - 1);
  const share = Math.floor(
    (Math.min(budget, ENKRYPT_MAX_CARRIED_USER_CHARACTERS) - separators) / carried.length
  );
  return joinRequestSegments(
    carried.flatMap(message => {
      const whole = sourceHeader('earlier user message');
      if (whole.length + 1 + message.length <= share) return [`${whole}\n${message}`];
      const header = sourceHeader(
        `earlier user message, shortened from ${message.length} characters`
      );
      const kept = excerpt(message, share - header.length - 1);
      return kept.length >= MIN_CARRIED_USER_CHARACTERS ? [`${header}\n${kept}`] : [];
    })
  );
}

/**
 * The text to scan when the first `cachedSegments` segments are cached: the uncached suffix, the
 * minimum overlap, and, while the scan stays within `ENKRYPT_CONTEXT_SCAN_CHARACTERS`, a longer
 * overlap and, for a policy scan, carried user messages. Only already-scanned context is ever
 * shortened; the uncached suffix is always sent whole.
 */
export function cachedScanText(
  segments: string[],
  cachedSegments: number,
  carryUserMessages: boolean
): string {
  const text = joinRequestSegments(segments);
  const cachedCharacters = joinRequestSegments(segments.slice(0, cachedSegments)).length;
  const latest = codePointBoundary(
    text,
    Math.max(0, cachedCharacters - ENKRYPT_MIN_SCAN_OVERLAP_CHARACTERS)
  );
  const extra = Math.max(0, ENKRYPT_CONTEXT_SCAN_CHARACTERS - (text.length - latest));
  const earliest = codePointBoundary(
    text,
    Math.max(0, cachedCharacters - ENKRYPT_MAX_SCAN_OVERLAP_CHARACTERS, latest - extra)
  );
  const { start, continuedHeader } = sourceAlignedStart(text, earliest, latest);
  const resent = text.slice(start);
  const overlap =
    continuedHeader && continuedHeader.length + 1 + resent.length <= ENKRYPT_MAX_SCAN_CHARACTERS
      ? `${continuedHeader}\n${resent}`
      : resent;
  const budget = ENKRYPT_CONTEXT_SCAN_CHARACTERS - overlap.length - '\n\n'.length;
  const carried =
    carryUserMessages && start > 0 && budget >= MIN_CARRIED_USER_CHARACTERS
      ? carriedUserMessages(text, start, budget)
      : '';
  return carried ? joinRequestSegments([carried, overlap]) : overlap;
}

/**
 * A log-only scan gates nothing, so its result is cached even when it fails, unless the client
 * disconnected. Otherwise a failure that recurs, such as a timeout, a detector error, or a request
 * too large to scan, would rescan, log, and possibly be charged for a growing suffix on every later
 * request of the conversation.
 */
function isCacheableAllow({ verdict, report, usageRecords }: EnkryptGuardrailScanResult): boolean {
  if (verdict.action !== 'allow') return false;
  if (report.scan === 'log_only') return report.decision !== 'client_aborted';
  return usageRecords.at(-1)?.decision === 'allowed';
}

/**
 * Scans only the part of the request that no earlier allowed request with the same scope covered,
 * plus already-scanned context; see `cachedScanText`. A cached block rejects requests retaining
 * that prefix. A cache failure scans the request in full, so it never lets unscanned content
 * through. A failed blocking scan is never cached; see `isCacheableAllow` for log-only scans.
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
    return { ...result, cacheEntry: null };
  }

  const keys = verdictCacheKeys(request, config, segments);
  const lookup = await cachedPrefix(request.organizationId, keys, config, deps.store);
  const cachedSegments = lookup === 'error' ? 0 : lookup.cachedSegments;
  const cachedCharacters = joinRequestSegments(segments.slice(0, cachedSegments)).length;
  const fullyCached = cachedSegments === segments.length;
  const coverage: EnkryptScanCoverage = {
    ...uncached,
    cache: lookup === 'error' ? 'error' : cachedSegments > 0 ? 'hit' : 'miss',
    cachedCharacters,
    cachedSegments,
  };
  if (lookup !== 'error' && lookup.verdict !== 'allow') {
    const report: EnkryptGuardrailScanResult['report'] = {
      scan: 'blocking',
      detectors_enabled: ENKRYPT_DETECTOR_IDS.filter(id => config.detectors[id] !== undefined),
      detectors_blocking: config.blockingDetectors,
      verdict_cache: 'hit',
      total_characters: text.length,
      total_segments: segments.length,
      cached_characters: cachedCharacters,
      cached_segments: cachedSegments,
      scanned_characters: 0,
      decision: 'blocked',
      error: null,
      detectors_fired: lookup.verdict.detectors,
      attempts: 0,
      credits_cost: null,
      latency_ms: 0,
    };
    console.debug('[enkrypt-guardrail] decision', {
      organization_id: request.organizationId,
      session_id: request.sessionId,
      client_request_id: request.clientRequestId,
      api_kind: request.apiKind,
      ...report,
    });
    return {
      verdict: { action: 'block', message: guardrailBlockMessage(lookup.verdict.detectors, null) },
      usageRecords: [],
      report,
      cacheEntry: null,
    };
  }
  const scannedText = fullyCached
    ? ''
    : cachedScanText(segments, cachedSegments, config.detectors.policy_violation !== undefined);

  const result = await scanRequest({ ...request, text: scannedText, coverage }, deps);
  const key = keys.at(-1);
  const finalDecision = result.usageRecords.at(-1)?.decision;
  const blockingDetectors = result.report.detectors_fired.filter(detector =>
    config.blockingDetectors.includes(detector)
  );
  let cacheEntry: EnkryptVerdictCacheEntry | null = null;
  if (!fullyCached && key) {
    if (isCacheableAllow(result)) {
      cacheEntry = { key, verdict: 'allow' };
    } else if (
      result.verdict.action === 'block' &&
      finalDecision === 'blocked' &&
      blockingDetectors.length > 0
    ) {
      cacheEntry = { key, verdict: { action: 'block', detectors: blockingDetectors } };
    }
  }
  return { ...result, cacheEntry };
}

export async function rememberRequestVerdict(
  { key, verdict }: EnkryptVerdictCacheEntry,
  store: EnkryptVerdictCacheStore
): Promise<EnkryptGuardrailReport['scans'][number]['verdict_cache_write']> {
  try {
    const result = await store.set(
      key,
      verdict,
      verdict === 'allow'
        ? { ex: ENKRYPT_VERDICT_CACHE_TTL_SECONDS, nx: true }
        : { ex: ENKRYPT_VERDICT_CACHE_TTL_SECONDS }
    );
    return result === null ? 'skipped' : 'written';
  } catch (error) {
    warnExceptInTest('[enkrypt-guardrail] verdict cache write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

import { createHash } from 'node:crypto';
import * as z from 'zod';
import { ENKRYPT_DETECTOR_IDS } from '@kilocode/db/schema-types';
import {
  guardrailBlockMessage,
  scanRequest,
  type EnkryptDetectDependencies,
  type EnkryptGuardrailScan,
  type EnkryptGuardrailScanResult,
  type EnkryptScanCoverage,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import {
  joinSegments,
  renderSegment,
  SEGMENT_SEPARATOR,
  segmentHeaderLine,
  type RequestScanParts,
  type RequestSegment,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';
import type { EnkryptInputGuardrailConfig } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import type { EnkryptGuardrailReport } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/** When false, every request is scanned in full. */
export const ENKRYPT_VERDICT_CACHE_ENABLED = true;

/**
 * Bump when key derivation or the meaning of a cached verdict changes, for example how detector
 * results are parsed or which detections block, so entries written by older code stop matching.
 * Extraction changes already change the hashed segments.
 */
const VERDICT_CACHE_VERSION = 3;

export const ENKRYPT_VERDICT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Already-scanned conversation text sent ahead of the uncached suffix, so content split across the
 * boundary is still scanned together. Context-dependent detection further back is not re-evaluated.
 */
export const ENKRYPT_SCAN_OVERLAP_CHARACTERS = 4_000;

/** Precedes the overlap when earlier conversation text is left out of a scan. */
export const OMITTED_CONVERSATION_MARKER = '[earlier conversation omitted]';

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
  parts: RequestScanParts;
};

type RequestPart = keyof RequestScanParts;

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
 * One key per segment, each covering the exact ordered content of the part up to and including
 * that segment: `h_0` hashes the scope, and `h_i = sha256(h_{i-1} || length || segment_i)`.
 * Editing, removing, or reordering any segment changes the keys of every later one, so a client
 * that rewrites history never inherits an earlier verdict. Segments are hashed as UTF-16 code units
 * to stay exact for lone surrogates, which UTF-8 would replace.
 *
 * The scope includes the part and the user, so scan latency cannot reveal whether another member
 * of the organization sent the same content.
 */
export function verdictCacheKeys(
  { organizationId, kiloUserId }: Pick<EnkryptGuardrailRequest, 'organizationId' | 'kiloUserId'>,
  config: ReadyConfig,
  part: RequestPart,
  segments: string[]
): string[] {
  const keyPrefix = `enkrypt-guardrail:verdict:v${VERDICT_CACHE_VERSION}:${organizationId}:${part}:`;
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

/**
 * The longest cached prefix among the keys from `firstProbed` on. Only the conversation is
 * matched by prefix; tool definitions and the system prompt probe only their full key.
 */
async function cachedPrefix(
  organizationId: string,
  keys: string[],
  firstProbed: number,
  config: ReadyConfig,
  store: EnkryptVerdictCacheStore
): Promise<{ cachedSegments: number; verdict: EnkryptVerdictCacheEntry['verdict'] } | 'error'> {
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

/** The last `length` characters, never starting between the two halves of a surrogate pair. */
function tail(text: string, length: number): string {
  const start = Math.max(0, text.length - length);
  return text.slice(isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start);
}

/**
 * The uncached conversation segments, preceded by up to `ENKRYPT_SCAN_OVERLAP_CHARACTERS` of the
 * cached ones. A segment cut by the overlap keeps its header, marked as missing its beginning, and
 * `OMITTED_CONVERSATION_MARKER` leads when any earlier text is left out.
 */
export function conversationScanText(
  segments: RequestSegment[],
  rendered: string[],
  cachedSegments: number
): string {
  if (cachedSegments === segments.length) return '';
  const overlap: string[] = [];
  let remaining = ENKRYPT_SCAN_OVERLAP_CHARACTERS;
  let index = cachedSegments;
  while (index > 0 && remaining > 0) {
    const segment = segments[index - 1];
    const text = rendered[index - 1];
    if (!segment || text === undefined) break;
    // The budget counts the body: a body that fits is kept whole, even when its header does not.
    if (text.length > remaining && (segment.body === null || segment.body.length > remaining)) {
      if (segment.body !== null) {
        const header = segmentHeaderLine(`${segment.header}, beginning omitted`);
        overlap.unshift(`${header}\n${tail(segment.body, remaining)}`);
      }
      break;
    }
    overlap.unshift(text);
    remaining -= text.length + SEGMENT_SEPARATOR.length;
    index--;
  }
  return joinSegments([
    ...(index > 0 ? [OMITTED_CONVERSATION_MARKER] : []),
    ...overlap,
    ...rendered.slice(cachedSegments),
  ]);
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
 * Scans one part of the request. The conversation is scanned only from where no earlier allowed
 * request with the same scope covered it, plus an overlap; tool definitions and the system prompt
 * are skipped only when the whole of them was allowed before. A cached block rejects requests retaining that content. A cache
 * failure scans the part in full, so it never lets unscanned content through. A failed blocking
 * scan is never cached; see `isCacheableAllow` for log-only scans.
 */
async function scanPartWithVerdictCache(
  part: RequestPart,
  segments: RequestSegment[],
  request: Omit<EnkryptGuardrailRequest, 'parts'>,
  deps: EnkryptDetectDependencies & { store: EnkryptVerdictCacheStore | null }
): Promise<EnkryptCachedScanResult> {
  const rendered = segments.map(renderSegment);
  const text = joinSegments(rendered);
  const uncached: EnkryptScanCoverage = {
    part,
    cache: 'off',
    totalCharacters: text.length,
    totalSegments: segments.length,
    cachedCharacters: 0,
    cachedSegments: 0,
    omittedAttachments: segments.filter(segment => segment.body === null).length,
  };
  const { config } = request;
  if (!deps.store || config.status !== 'ready' || segments.length === 0) {
    const result = await scanRequest({ ...request, text, coverage: uncached }, deps);
    return { ...result, cacheEntry: null };
  }

  const keys = verdictCacheKeys(request, config, part, rendered);
  const firstProbed =
    part === 'conversation' ? Math.max(0, keys.length - MAX_PROBED_PREFIXES) : keys.length - 1;
  const lookup = await cachedPrefix(request.organizationId, keys, firstProbed, config, deps.store);
  const cachedSegments = lookup === 'error' ? 0 : lookup.cachedSegments;
  const cachedCharacters = joinSegments(rendered.slice(0, cachedSegments)).length;
  const coverage: EnkryptScanCoverage = {
    ...uncached,
    cache: lookup === 'error' ? 'error' : cachedSegments > 0 ? 'hit' : 'miss',
    cachedCharacters,
    cachedSegments,
  };
  if (lookup !== 'error' && lookup.verdict !== 'allow') {
    const report: EnkryptGuardrailScanResult['report'] = {
      scan: 'blocking',
      part,
      detectors_enabled: ENKRYPT_DETECTOR_IDS.filter(id => config.detectors[id] !== undefined),
      detectors_blocking: config.blockingDetectors,
      verdict_cache: 'hit',
      total_characters: text.length,
      total_segments: segments.length,
      cached_characters: cachedCharacters,
      cached_segments: cachedSegments,
      omitted_attachments: coverage.omittedAttachments,
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
  const fullyCached = cachedSegments === segments.length;
  const scannedText =
    part === 'conversation'
      ? conversationScanText(segments, rendered, cachedSegments)
      : fullyCached
        ? ''
        : text;

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

const REQUEST_PARTS: readonly RequestPart[] = ['tools', 'system', 'conversation'];

/**
 * Scans the request's tool definitions and system prompt, when it has any, and its conversation in
 * concurrent Enkrypt calls, each with its own verdict cache entries. Returns one result per scanned
 * part, in `REQUEST_PARTS` order.
 */
export async function scanRequestWithVerdictCache(
  { parts, ...request }: EnkryptGuardrailRequest,
  deps: EnkryptDetectDependencies & { store: EnkryptVerdictCacheStore | null }
): Promise<EnkryptCachedScanResult[]> {
  return Promise.all(
    REQUEST_PARTS.filter(part => part === 'conversation' || parts[part].length > 0).map(part =>
      scanPartWithVerdictCache(part, parts[part], request, deps)
    )
  );
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

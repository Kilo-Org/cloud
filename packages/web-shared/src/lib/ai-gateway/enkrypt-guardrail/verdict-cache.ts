import { createHash } from 'node:crypto';
import * as z from 'zod';
import { ENKRYPT_DETECTOR_IDS } from '@kilocode/db/schema-types';
import {
  guardrailBlockMessage,
  scanRequest,
  type EnkryptDetectDependencies,
  type EnkryptGuardrailScan,
  type EnkryptGuardrailScanResult,
  type EnkryptGuardrailVerdict,
  type EnkryptScanCoverage,
  scanKind,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import {
  joinSegments,
  renderSegment,
  SEGMENT_SEPARATOR,
  segmentHeaderLine,
  type RequestScanParts,
  type RequestSegment,
  type RequestToolDefinition,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';
import type { EnkryptInputGuardrailConfig } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import {
  MAX_REPORTED_FLAGGED_TOOLS,
  type EnkryptFlaggedTool,
  type EnkryptGuardrailReport,
  type EnkryptInputPartScanReport,
  type EnkryptToolScanReport,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/** When false, every request is scanned in full. */
export const ENKRYPT_VERDICT_CACHE_ENABLED = true;

/**
 * Bump when key derivation or the meaning of a cached verdict changes, for example how detector
 * results are parsed or which detections block, so entries written by older code stop matching.
 * Extraction changes already change the hashed segments.
 */
const VERDICT_CACHE_VERSION = 4;

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
  report: EnkryptInputPartScanReport | null;
  /** One entry per tool definition, system prompt, or conversation whose verdict can be cached. */
  cacheEntries: EnkryptVerdictCacheEntry[];
};

type ReadyConfig = Extract<EnkryptInputGuardrailConfig, { status: 'ready' }>;

type ScanDependencies = EnkryptDetectDependencies & { store: EnkryptVerdictCacheStore | null };

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
 * to stay exact for lone surrogates, which UTF-8 would replace. Each tool definition is keyed on
 * its own, as a part of one segment.
 *
 * The scope is the organization, the part, and the detector configuration, but not the user, so
 * members of an organization share verdicts: the same tool definitions and system prompt are
 * scanned once for all of them. Scan latency can therefore reveal to a member that someone in their
 * organization sent the same content before. For tool definitions and system prompts, which coding
 * agents mostly ship, that is accepted. A conversation key covers the whole conversation up to its
 * segment, so only a member who already has that exact conversation can hit it.
 */
export function verdictCacheKeys(
  { organizationId }: Pick<EnkryptGuardrailRequest, 'organizationId'>,
  config: ReadyConfig,
  part: RequestPart,
  segments: string[]
): string[] {
  const keyPrefix = `enkrypt-guardrail:verdict:v${VERDICT_CACHE_VERSION}:${organizationId}:${part}:`;
  let chain = createHash('sha256').update(keyPrefix).update(configHash(config)).digest();
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
 * A cached verdict, or null for none. A block names only detectors that block now, so a detector
 * switched to log only no longer rejects content cached as blocked.
 */
function cachedVerdict(
  value: unknown,
  config: ReadyConfig
): EnkryptVerdictCacheEntry['verdict'] | null {
  if (value === 'allow') return 'allow';
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const blocked = cachedBlockVerdictSchema.safeParse(parsed);
  return blocked.success &&
    blocked.data.detectors.every(detector => config.blockingDetectors.includes(detector))
    ? blocked.data
    : null;
}

async function lookup(
  organizationId: string,
  keys: string[],
  store: EnkryptVerdictCacheStore
): Promise<unknown[] | 'error'> {
  if (keys.length === 0) return [];
  try {
    return await store.mget(keys);
  } catch (error) {
    warnExceptInTest('[enkrypt-guardrail] verdict cache lookup failed; scanning in full', {
      organization_id: organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'error';
  }
}

/**
 * The longest cached prefix among the keys from `firstProbed` on. Only the conversation is
 * matched by prefix; the system prompt probes only its full key.
 */
async function cachedPrefix(
  organizationId: string,
  keys: string[],
  firstProbed: number,
  config: ReadyConfig,
  store: EnkryptVerdictCacheStore
): Promise<{ cachedSegments: number; verdict: EnkryptVerdictCacheEntry['verdict'] } | 'error'> {
  const values = await lookup(organizationId, keys.slice(firstProbed), store);
  if (values === 'error') return 'error';
  let cachedSegments = 0;
  for (const [index, value] of values.entries()) {
    const segments = firstProbed + index + 1;
    const verdict = cachedVerdict(value, config);
    if (verdict === 'allow') cachedSegments = segments;
    else if (verdict) return { cachedSegments: segments, verdict };
  }
  return { cachedSegments, verdict: 'allow' };
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
 * disconnected or the scan ran out of time before any call. Otherwise a failure that recurs, such
 * as a timeout, a detector error, or a request too large to scan, would rescan, log, and possibly be
 * charged for a growing suffix on every later request of the conversation. A scan that never got a
 * call slot in time was not charged, and the next request scans it.
 */
function isCacheableAllow({ verdict, report, usageRecords }: EnkryptGuardrailScanResult): boolean {
  if (verdict.action !== 'allow') return false;
  if (report.scan === 'log_only') {
    return (
      report.decision !== 'client_aborted' && !(report.error === 'timeout' && report.attempts === 0)
    );
  }
  return usageRecords.at(-1)?.decision === 'allowed';
}

/** What to cache for a scan whose content had no cached verdict: an allow, a genuine block, or nothing. */
function cacheEntryFor(
  key: string,
  result: EnkryptGuardrailScanResult,
  config: ReadyConfig
): EnkryptVerdictCacheEntry | null {
  if (isCacheableAllow(result)) return { key, verdict: 'allow' };
  const blockingDetectors = result.report.detectors_fired.filter(detector =>
    config.blockingDetectors.includes(detector)
  );
  return result.verdict.action === 'block' &&
    result.usageRecords.at(-1)?.decision === 'blocked' &&
    blockingDetectors.length > 0
    ? { key, verdict: { action: 'block', detectors: blockingDetectors } }
    : null;
}

function logFields(request: Omit<EnkryptGuardrailRequest, 'parts'>) {
  return {
    organization_id: request.organizationId,
    session_id: request.sessionId,
    client_request_id: request.clientRequestId,
    api_kind: request.apiKind,
  };
}

/**
 * A part's verdict cache lookup, done before any of the request's scans start: the Enkrypt calls it
 * still needs, and how to turn their results into the part's result.
 */
type PartPlan = {
  scans: EnkryptGuardrailScan[];
  finish(results: EnkryptGuardrailScanResult[]): EnkryptCachedScanResult;
};

/**
 * Plans the system prompt or the conversation. The conversation is scanned only from where no
 * earlier allowed request with the same scope covered it, plus an overlap; the system prompt is
 * skipped only when the whole of it was allowed before. A cached block rejects requests retaining
 * that content. A cache failure scans the part in full, so it never lets unscanned content through.
 * A failed blocking scan is never cached; see `isCacheableAllow` for log-only scans.
 */
async function planSegmentsPart(
  part: 'system' | 'conversation',
  segments: RequestSegment[],
  request: Omit<EnkryptGuardrailRequest, 'parts'>,
  store: EnkryptVerdictCacheStore | null
): Promise<PartPlan> {
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
  const scanOf = (result: EnkryptGuardrailScanResult, key?: string): EnkryptCachedScanResult => {
    const cacheEntry = key && config.status === 'ready' && cacheEntryFor(key, result, config);
    return {
      ...result,
      report: { ...result.report, part },
      cacheEntries: cacheEntry ? [cacheEntry] : [],
    };
  };
  if (!store || config.status !== 'ready' || segments.length === 0) {
    return {
      scans: [{ ...request, text, coverage: uncached }],
      finish: ([result]) => scanOf(required(result)),
    };
  }

  const keys = verdictCacheKeys(request, config, part, rendered);
  const firstProbed =
    part === 'conversation' ? Math.max(0, keys.length - MAX_PROBED_PREFIXES) : keys.length - 1;
  const cached = await cachedPrefix(request.organizationId, keys, firstProbed, config, store);
  const cachedSegments = cached === 'error' ? 0 : cached.cachedSegments;
  const cachedCharacters = joinSegments(rendered.slice(0, cachedSegments)).length;
  const coverage: EnkryptScanCoverage = {
    ...uncached,
    cache: cached === 'error' ? 'error' : cachedSegments > 0 ? 'hit' : 'miss',
    cachedCharacters,
    cachedSegments,
  };
  if (cached !== 'error' && cached.verdict !== 'allow') {
    const { detectors } = cached.verdict;
    const report: EnkryptInputPartScanReport = {
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
      detectors_fired: detectors,
      attempts: 0,
      credits_cost: null,
      latency_ms: 0,
    };
    console.debug('[enkrypt-guardrail] decision', { ...logFields(request), ...report });
    return {
      scans: [],
      finish: () => ({
        verdict: { action: 'block', message: guardrailBlockMessage(detectors, null) },
        usageRecords: [],
        report,
        cacheEntries: [],
      }),
    };
  }
  const fullyCached = cachedSegments === segments.length;
  const scannedText =
    part === 'conversation'
      ? conversationScanText(segments, rendered, cachedSegments)
      : fullyCached
        ? ''
        : text;
  return {
    scans: [{ ...request, text: scannedText, coverage }],
    finish: ([result]) => scanOf(required(result), fullyCached ? undefined : keys.at(-1)),
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing scan result');
  return value;
}

const DECISION_SEVERITY: readonly EnkryptToolScanReport['decision'][] = [
  'blocked',
  'error_fail_closed',
  'error_logged',
  'client_aborted',
  'allowed',
];

function bySeverity<T extends { decision: EnkryptToolScanReport['decision'] }>(a: T, b: T): number {
  return DECISION_SEVERITY.indexOf(a.decision) - DECISION_SEVERITY.indexOf(b.decision);
}

/** A verdict acts on its most severe source: a block, then an unavailable scan. */
export function mostSevereVerdict(verdicts: EnkryptGuardrailVerdict[]): EnkryptGuardrailVerdict {
  return (
    verdicts.find(verdict => verdict.action === 'block') ??
    verdicts.find(verdict => verdict.action === 'unavailable') ??
    verdicts.find(verdict => verdict.action === 'allow') ?? { action: 'skip' }
  );
}

/** The outcome of one tool definition: its cached verdict, or the scan of it. */
type ToolOutcome = {
  tool: RequestToolDefinition;
  characters: number;
  outcome:
    | { kind: 'cached'; verdict: EnkryptVerdictCacheEntry['verdict'] }
    | { kind: 'scanned'; result: EnkryptGuardrailScanResult; key: string | null };
};

function flaggedTool({
  tool,
  outcome,
}: ToolOutcome): (EnkryptFlaggedTool & { decision: EnkryptToolScanReport['decision'] }) | null {
  const base = { kind: tool.kind, name: tool.name };
  if (outcome.kind === 'cached') {
    return outcome.verdict === 'allow'
      ? null
      : { ...base, detectors_fired: outcome.verdict.detectors, error: null, decision: 'blocked' };
  }
  const { report } = outcome.result;
  if (report.decision === 'client_aborted') return null;
  if (report.detectors_fired.length === 0 && report.error === null) return null;
  return {
    ...base,
    detectors_fired: report.detectors_fired,
    error: report.error,
    decision: report.decision,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function toolsReport(
  kind: EnkryptToolScanReport['scan'],
  config: EnkryptInputGuardrailConfig,
  cache: EnkryptToolScanReport['verdict_cache'],
  outcomes: ToolOutcome[]
): EnkryptToolScanReport {
  const cached = outcomes.filter(each => each.outcome.kind === 'cached');
  const reports = outcomes.flatMap(({ outcome }) =>
    outcome.kind === 'scanned' ? [outcome.result.report] : []
  );
  const flagged = outcomes.flatMap(each => flaggedTool(each) ?? []).sort(bySeverity);
  const decisions = [
    ...reports.map(report => report.decision),
    ...flagged.map(each => each.decision),
  ];
  const decision = DECISION_SEVERITY.find(each => decisions.includes(each)) ?? 'allowed';
  const credits = reports.flatMap(report =>
    report.credits_cost === null ? [] : [report.credits_cost]
  );
  return {
    scan: kind,
    part: 'tools',
    detectors_enabled:
      config.status === 'ready'
        ? ENKRYPT_DETECTOR_IDS.filter(id => config.detectors[id] !== undefined)
        : [],
    detectors_blocking: config.status === 'ready' ? config.blockingDetectors : [],
    verdict_cache: cache === 'miss' && cached.length > 0 ? 'hit' : cache,
    tools_total: outcomes.length,
    tools_cached: cached.length,
    tools_scanned: outcomes.length - cached.length,
    tools_flagged: flagged.length,
    total_characters: sum(outcomes.map(each => each.characters)),
    cached_characters: sum(cached.map(each => each.characters)),
    scanned_characters: sum(reports.map(report => report.scanned_characters)),
    decision,
    error: [...reports].sort(bySeverity).find(report => report.error !== null)?.error ?? null,
    detectors_fired: ENKRYPT_DETECTOR_IDS.filter(id =>
      flagged.some(each => each.detectors_fired.includes(id))
    ),
    attempts: sum(reports.map(report => report.attempts)),
    credits_cost: credits.length === 0 ? null : sum(credits),
    latency_ms: reports.reduce((latest, report) => Math.max(latest, report.latency_ms), 0),
    flagged_tools: flagged.slice(0, MAX_REPORTED_FLAGGED_TOOLS).map(each => ({
      kind: each.kind,
      name: each.name,
      detectors_fired: each.detectors_fired,
      error: each.error,
    })),
  };
}

/**
 * Plans the tool definitions and response formats. Each is looked up and cached by exact match on
 * its own, so a changed, added, or removed tool rescans only that tool, and each uncached one is
 * scanned by its own Enkrypt call, which also keeps every call far below the scan limit. Each call
 * pays Enkrypt's per-call minimum, so an uncached tool set costs more than one combined call would;
 * verdicts are shared across the organization, so that is paid once per tool and detector set.
 * The results are aggregated into one result for the part: it blocks when any tool blocks, and is
 * otherwise unavailable when any tool's scan is.
 */
async function planTools(
  tools: RequestToolDefinition[],
  request: Omit<EnkryptGuardrailRequest, 'parts'>,
  store: EnkryptVerdictCacheStore | null
): Promise<PartPlan> {
  const { config } = request;
  const ready = config.status === 'ready' ? config : null;
  const texts = tools.map(tool => joinSegments(tool.segments.map(renderSegment)));
  const keys = ready
    ? texts.map(text => required(verdictCacheKeys(request, ready, 'tools', [text])[0]))
    : null;
  const values = store && keys ? await lookup(request.organizationId, keys, store) : null;
  const cache: EnkryptToolScanReport['verdict_cache'] =
    values === null ? 'off' : values === 'error' ? 'error' : 'miss';
  const verdicts = tools.map((_, index) =>
    ready && Array.isArray(values) ? cachedVerdict(values[index], ready) : null
  );
  const scans = tools.flatMap((tool, index): EnkryptGuardrailScan[] => {
    if (verdicts[index]) return [];
    const text = texts[index] ?? '';
    return [
      {
        ...request,
        text,
        coverage: {
          part: 'tools',
          cache,
          totalCharacters: text.length,
          totalSegments: tool.segments.length,
          cachedCharacters: 0,
          cachedSegments: 0,
          omittedAttachments: 0,
          tool: { kind: tool.kind, name: tool.name },
        },
      },
    ];
  });
  return {
    scans,
    finish(results) {
      let scanned = 0;
      const outcomes = tools.map((tool, index): ToolOutcome => {
        const characters = texts[index]?.length ?? 0;
        const verdict = verdicts[index];
        if (verdict) return { tool, characters, outcome: { kind: 'cached', verdict } };
        const result = required(results[scanned++]);
        return {
          tool,
          characters,
          outcome: { kind: 'scanned', result, key: keys?.[index] ?? null },
        };
      });
      const report = toolsReport(scanKind(config), config, cache, outcomes);
      if (report.tools_cached > 0) {
        console.debug('[enkrypt-guardrail] tool definitions', { ...logFields(request), ...report });
      }
      return {
        verdict: mostSevereVerdict(
          outcomes.map(({ outcome }): EnkryptGuardrailVerdict => {
            if (outcome.kind === 'scanned') return outcome.result.verdict;
            return outcome.verdict === 'allow'
              ? { action: 'allow' }
              : {
                  action: 'block',
                  message: guardrailBlockMessage(outcome.verdict.detectors, null),
                };
          })
        ),
        usageRecords: outcomes.flatMap(({ outcome }) =>
          outcome.kind === 'scanned' ? outcome.result.usageRecords : []
        ),
        report,
        cacheEntries: outcomes.flatMap(({ outcome }) => {
          if (outcome.kind !== 'scanned' || !outcome.key || !ready) return [];
          return cacheEntryFor(outcome.key, outcome.result, ready) ?? [];
        }),
      };
    },
  };
}

/**
 * Scans the request's tool definitions, each on its own, its system prompt, when it has any, and
 * its conversation, each with its own verdict cache entries. Returns one result per scanned part,
 * in tools, system, conversation order.
 *
 * Every verdict cache lookup finishes before any scan starts. The scans then start longest text
 * first, so with `deps.limiter` capping concurrent calls the long ones do not run last and hold up
 * the verdict. They share one deadline, started before the lookups, which includes time spent
 * waiting for a call slot, so the part results arrive within `deps.timeoutMs` plus the lookup.
 */
export async function scanRequestWithVerdictCache(
  { parts, ...request }: EnkryptGuardrailRequest,
  { store, ...deps }: ScanDependencies
): Promise<EnkryptCachedScanResult[]> {
  const scanDeps: EnkryptDetectDependencies = {
    ...deps,
    deadline: deps.deadline ?? AbortSignal.timeout(deps.timeoutMs),
  };
  const plans = await Promise.all([
    ...(parts.tools.length > 0 ? [planTools(parts.tools, request, store)] : []),
    ...(parts.system.length > 0 ? [planSegmentsPart('system', parts.system, request, store)] : []),
    planSegmentsPart('conversation', parts.conversation, request, store),
  ]);
  const started = new Map<EnkryptGuardrailScan, Promise<EnkryptGuardrailScanResult>>();
  const byLength = plans.flatMap(plan => plan.scans).sort((a, b) => b.text.length - a.text.length);
  for (const scan of byLength) started.set(scan, scanRequest(scan, scanDeps));
  return Promise.all(
    plans.map(async plan =>
      plan.finish(await Promise.all(plan.scans.map(scan => required(started.get(scan)))))
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

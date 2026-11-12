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
  type RequestScanParts,
  type RequestSegment,
  type RequestToolDefinition,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';
import {
  OMITTED_TEXT_MARKERS,
  scanChunks,
  type ScanChunk,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/scan-chunks';
import type { EnkryptGuardrailConfig } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import {
  MAX_REPORTED_FLAGGED_TOOLS,
  type EnkryptFlaggedTool,
  type EnkryptGuardrailReport,
  type EnkryptInputPartScanReport,
  type EnkryptScanReport,
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
const VERDICT_CACHE_VERSION = 5;

export const ENKRYPT_VERDICT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

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

type ReadyConfig = Extract<EnkryptGuardrailConfig, { status: 'ready' }>;

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
function cacheableVerdict(
  result: EnkryptGuardrailScanResult,
  config: ReadyConfig
): EnkryptVerdictCacheEntry['verdict'] | null {
  if (isCacheableAllow(result)) return 'allow';
  const blockingDetectors = result.report.detectors_fired.filter(detector =>
    config.blockingDetectors.includes(detector)
  );
  return result.verdict.action === 'block' &&
    result.usageRecords.at(-1)?.decision === 'blocked' &&
    blockingDetectors.length > 0
    ? { action: 'block', detectors: blockingDetectors }
    : null;
}

/**
 * Where a part's verdicts are cached: `allow(through)` is the key for its content up to segment
 * `through`, or null when only the whole part is keyed and `through` falls short of it, and
 * `block(reaches)` the key for a block found in content reaching into segment `reaches`.
 */
type PartKeys = {
  allow(through: number): string | null;
  block(reaches: number): string;
};

/** The conversation is keyed by prefix, so every segment boundary has a key. */
function prefixKeys(keys: string[]): PartKeys {
  return {
    allow: through => keys[through - 1] ?? null,
    block: reaches => required(keys[reaches - 1]),
  };
}

/** A tool definition or the system prompt is keyed only as a whole. */
function wholeKey(key: string, segments: number): PartKeys {
  return { allow: through => (through === segments ? key : null), block: () => key };
}

/**
 * What to cache for a part scanned in chunks. Each run of allowed chunks from the start caches an
 * allow at the boundary it reached, so after a chunk fails or runs out of time, the next request of
 * the conversation resumes from there. Cold scans are rare, the writes are deferred, and an allow
 * is never overwritten, so a few writes for them are cheap. The first genuine block is cached for
 * every request retaining the content its chunk reached into.
 */
function chunkCacheEntries(
  chunks: ScanChunk[],
  results: EnkryptGuardrailScanResult[],
  config: ReadyConfig,
  cachedSegments: number,
  keys: PartKeys
): EnkryptVerdictCacheEntry[] {
  const entries: EnkryptVerdictCacheEntry[] = [];
  let allowedThrough: number | null = cachedSegments;
  for (const [index, chunk] of chunks.entries()) {
    const verdict = cacheableVerdict(required(results[index]), config);
    if (verdict !== 'allow') {
      allowedThrough = null;
      if (verdict) return [...entries, { key: keys.block(chunk.reaches), verdict }];
      continue;
    }
    if (allowedThrough === null || chunk.through <= allowedThrough) continue;
    allowedThrough = chunk.through;
    const key = keys.allow(chunk.through);
    if (key) entries.push({ key, verdict });
  }
  return entries;
}

const DECISION_SEVERITY: readonly EnkryptScanReport['decision'][] = [
  'blocked',
  'error_fail_closed',
  'error_logged',
  'client_aborted',
  'allowed',
];

function bySeverity<T extends { decision: EnkryptScanReport['decision'] }>(a: T, b: T): number {
  return DECISION_SEVERITY.indexOf(a.decision) - DECISION_SEVERITY.indexOf(b.decision);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function totalCredits(reports: { credits_cost: number | null }[]): number | null {
  const credits = reports.flatMap(report =>
    report.credits_cost === null ? [] : [report.credits_cost]
  );
  return credits.length === 0 ? null : sum(credits);
}

/**
 * The result of a part scanned in chunks: it blocks when any chunk blocks, and is otherwise
 * unavailable when any chunk's scan is, so a chunk that fails never lets the part through.
 */
function combineChunks(results: EnkryptGuardrailScanResult[]): EnkryptGuardrailScanResult {
  const reports = results.map(result => result.report);
  const [first] = reports;
  if (!first || reports.length === 1) return required(results[0]);
  const bySeverest = [...reports].sort(bySeverity);
  return {
    verdict: mostSevereVerdict(results.map(result => result.verdict)),
    usageRecords: results.flatMap(result => result.usageRecords),
    report: {
      ...first,
      scanned_characters: sum(reports.map(report => report.scanned_characters)),
      decision: required(bySeverest[0]).decision,
      error: bySeverest.find(report => report.error !== null)?.error ?? null,
      detectors_fired: ENKRYPT_DETECTOR_IDS.filter(id =>
        reports.some(report => report.detectors_fired.includes(id))
      ),
      attempts: sum(reports.map(report => report.attempts)),
      credits_cost: totalCredits(reports),
      latency_ms: Math.max(...reports.map(report => report.latency_ms)),
    },
  };
}

function chunkScans(
  request: Omit<EnkryptGuardrailRequest, 'parts'>,
  coverage: EnkryptScanCoverage,
  chunks: ScanChunk[]
): EnkryptGuardrailScan[] {
  return chunks.map((chunk, index) => ({
    ...request,
    text: chunk.text,
    coverage: { ...coverage, chunk: { index, count: chunks.length } },
  }));
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
 * still needs, as the chunks of each text it scans in order, and how to turn their results, in the
 * same order, into the part's result.
 */
type PartPlan = {
  texts: EnkryptGuardrailScan[][];
  finish(results: EnkryptGuardrailScanResult[]): EnkryptCachedScanResult;
};

/**
 * The chunks of a part's uncached text, from segment `start` on, and a scan for each. With nothing
 * to scan, one scan of no text still reports the part, without an Enkrypt call.
 */
function chunkedPlan(
  part: keyof RequestScanParts,
  segments: RequestSegment[],
  start: number,
  request: Omit<EnkryptGuardrailRequest, 'parts'>,
  coverage: EnkryptScanCoverage
): { chunks: ScanChunk[]; scans: EnkryptGuardrailScan[] } {
  const chunks = scanChunks(segments, start, OMITTED_TEXT_MARKERS[part]);
  return {
    chunks,
    scans:
      chunks.length > 0
        ? chunkScans(request, coverage, chunks)
        : [{ ...request, text: '', coverage }],
  };
}

/**
 * Plans the system prompt or the conversation. The conversation is scanned only from where no
 * earlier allowed request with the same scope covered it, plus an overlap; the system prompt is
 * skipped only when the whole of it was allowed before. Text too long for one Enkrypt call is
 * scanned in chunks. A cached block rejects requests retaining that content. A cache failure scans
 * the part in full, so it never lets unscanned content through. A failed blocking scan is never
 * cached; see `isCacheableAllow` for log-only scans.
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
  const scanOf = (
    { chunks, scans }: ReturnType<typeof chunkedPlan>,
    cacheEntries: (results: EnkryptGuardrailScanResult[]) => EnkryptVerdictCacheEntry[]
  ): PartPlan => ({
    texts: [scans],
    finish(results) {
      const result = combineChunks(results);
      return {
        ...result,
        report: { ...result.report, part, chunks: chunks.length },
        cacheEntries: cacheEntries(results),
      };
    },
  });
  if (!store || config.status !== 'ready' || segments.length === 0) {
    return scanOf(chunkedPlan(part, segments, 0, request, uncached), () => []);
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
      chunks: 0,
    };
    console.debug('[enkrypt-guardrail] decision', { ...logFields(request), ...report });
    return {
      texts: [],
      finish: () => ({
        verdict: { action: 'block', message: guardrailBlockMessage(detectors, null) },
        usageRecords: [],
        report,
        cacheEntries: [],
      }),
    };
  }
  const plan = chunkedPlan(part, segments, cachedSegments, request, coverage);
  const partKeys =
    part === 'conversation' ? prefixKeys(keys) : wholeKey(required(keys.at(-1)), keys.length);
  return scanOf(plan, results =>
    chunkCacheEntries(plan.chunks, results, config, cachedSegments, partKeys)
  );
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing scan result');
  return value;
}

/** A verdict acts on its most severe source: a block, then an unavailable scan. */
export function mostSevereVerdict(verdicts: EnkryptGuardrailVerdict[]): EnkryptGuardrailVerdict {
  return (
    verdicts.find(verdict => verdict.action === 'block') ??
    verdicts.find(verdict => verdict.action === 'unavailable') ??
    verdicts.find(verdict => verdict.action === 'allow') ?? { action: 'skip' }
  );
}

/** The outcome of one tool definition: its cached verdict, or the scan of it, in chunks. */
type ToolOutcome = {
  tool: RequestToolDefinition;
  characters: number;
  outcome:
    | { kind: 'cached'; verdict: EnkryptVerdictCacheEntry['verdict'] }
    | {
        kind: 'scanned';
        result: EnkryptGuardrailScanResult;
        cacheEntries: EnkryptVerdictCacheEntry[];
      };
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

function toolsReport(
  kind: EnkryptToolScanReport['scan'],
  config: EnkryptGuardrailConfig,
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
    credits_cost: totalCredits(reports),
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
 * scanned by its own Enkrypt calls: one, unless it is too long for one call and is scanned in
 * chunks. Each call pays Enkrypt's per-call minimum, so an uncached tool set costs more than one
 * combined call would; verdicts are shared across the organization, so that is paid once per tool
 * and detector set. The results are aggregated into one result for the part: it blocks when any
 * tool blocks, and is otherwise unavailable when any tool's scan is.
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
  const plans = tools.map((tool, index) => {
    const verdict = ready && Array.isArray(values) ? cachedVerdict(values[index], ready) : null;
    if (verdict) return { verdict };
    return chunkedPlan('tools', tool.segments, 0, request, {
      part: 'tools',
      cache,
      totalCharacters: texts[index]?.length ?? 0,
      totalSegments: tool.segments.length,
      cachedCharacters: 0,
      cachedSegments: 0,
      omittedAttachments: 0,
    });
  });
  return {
    texts: plans.flatMap(plan => ('scans' in plan ? [plan.scans] : [])),
    finish(results) {
      let scanned = 0;
      const outcomes = tools.map((tool, index): ToolOutcome => {
        const characters = texts[index]?.length ?? 0;
        const plan = required(plans[index]);
        if ('verdict' in plan) {
          return { tool, characters, outcome: { kind: 'cached', verdict: plan.verdict } };
        }
        const chunkResults = results.slice(scanned, (scanned += plan.scans.length));
        const key = keys?.[index];
        return {
          tool,
          characters,
          outcome: {
            kind: 'scanned',
            result: combineChunks(chunkResults),
            cacheEntries:
              ready && key
                ? chunkCacheEntries(
                    plan.chunks,
                    chunkResults,
                    ready,
                    0,
                    wholeKey(key, tool.segments.length)
                  )
                : [],
          },
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
        cacheEntries: outcomes.flatMap(({ outcome }) =>
          outcome.kind === 'scanned' ? outcome.cacheEntries : []
        ),
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
 * the verdict. A text's chunks start in order, ranked by its longest chunk, so when the deadline
 * cuts a long conversation short, its allowed chunks are a prefix the next request resumes from.
 * They share one deadline, started before the lookups, which includes time spent waiting for a
 * call slot, so the part results arrive within `deps.timeoutMs` plus the lookup.
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
  const longestChunk = (chunks: EnkryptGuardrailScan[]) =>
    Math.max(0, ...chunks.map(scan => scan.text.length));
  const started = new Map<EnkryptGuardrailScan, Promise<EnkryptGuardrailScanResult>>();
  const byLength = plans
    .flatMap(plan => plan.texts)
    .sort((a, b) => longestChunk(b) - longestChunk(a));
  for (const scan of byLength.flat()) started.set(scan, scanRequest(scan, scanDeps));
  return Promise.all(
    plans.map(async plan =>
      plan.finish(await Promise.all(plan.texts.flat().map(scan => required(started.get(scan)))))
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

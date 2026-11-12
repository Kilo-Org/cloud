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
  type EnkryptScanContext,
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
  packUnits,
  scanUnits,
  type ScanUnit,
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

/**
 * Bump when key derivation or the meaning of a cached verdict changes, for example how detector
 * results are parsed or which detections block, so entries written by older code stop matching.
 * Extraction changes already change the hashed segments.
 */
const VERDICT_CACHE_VERSION = 6;

export const ENKRYPT_VERDICT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

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

export type EnkryptGuardrailRequest = EnkryptScanContext & {
  parts: RequestScanParts;
};

type RequestPart = keyof RequestScanParts;

export type EnkryptCachedScanResult = Omit<EnkryptGuardrailScanResult, 'report'> & {
  /** Null when no scan ran. */
  report: EnkryptInputPartScanReport | null;
  /** One entry per segment, or slice of one, whose verdict can be cached. */
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
 * The key of one unit: a segment, or a slice of a segment too long for one Enkrypt call. Enkrypt
 * judges chunks of its input individually, so a unit's verdict does not depend on the text around
 * it, and each unit is cached on its own wherever it appears. Text is hashed as UTF-16 code units
 * to stay exact for lone surrogates, which UTF-8 would replace.
 *
 * The scope is the organization, the part, and the detector configuration, but not the user, so
 * members of an organization share verdicts: the same tool definitions, system prompts, and
 * messages are scanned once for all of them.
 *
 * Timing attacks on this cache between members of the same organization are deliberately not
 * defended against: scan latency can reveal to a member that someone in their organization sent
 * the same text before, and we accept that within an organization. Keys never cross organizations.
 */
export function verdictCacheKey(
  { organizationId }: Pick<EnkryptGuardrailRequest, 'organizationId'>,
  config: ReadyConfig,
  part: RequestPart,
  text: string
): string {
  const keyPrefix = `enkrypt-guardrail:verdict:v${VERDICT_CACHE_VERSION}:${organizationId}:${part}:`;
  const hash = createHash('sha256')
    .update(keyPrefix)
    .update(configHash(config))
    .update(`${text.length}:`)
    .update(text, 'utf16le')
    .digest('hex');
  return `${keyPrefix}${hash}`;
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
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const blocked = cachedBlockVerdictSchema.safeParse(parsed);
  return blocked.success &&
    blocked.data.detectors.every(detector => config.blockingDetectors.includes(detector))
    ? blocked.data
    : null;
}

type CachedVerdict = EnkryptVerdictCacheEntry['verdict'];

/** The verdict cache of a request, when it is used: with a store and a ready configuration. */
type VerdictCache = { store: EnkryptVerdictCacheStore; config: ReadyConfig };

/** A unit and its verdict cache key, or null when the cache is not used. */
type KeyedUnit = ScanUnit & { key: string | null };

/** A unit and its cached verdict, or null for none. */
type LookedUpUnit = KeyedUnit & { verdict: CachedVerdict | null };

function keyedUnits(
  request: EnkryptScanContext,
  part: RequestPart,
  segments: RequestSegment[],
  cache: VerdictCache | null
): KeyedUnit[] {
  return scanUnits(segments).map(unit => ({
    ...unit,
    key: cache ? verdictCacheKey(request, cache.config, part, unit.text) : null,
  }));
}

/**
 * The cached verdicts of `units`, by key, looked up in one call, and the cache status: `off` when
 * the cache is not used or there is nothing to look up. A failed lookup finds no verdict, so every
 * unit is scanned.
 */
async function lookup(
  organizationId: string,
  units: KeyedUnit[],
  cache: VerdictCache | null
): Promise<{ status: EnkryptScanCoverage['cache']; verdicts: Map<string, CachedVerdict> }> {
  const verdicts = new Map<string, CachedVerdict>();
  const keys = units.flatMap(unit => (unit.key ? [unit.key] : []));
  if (!cache || keys.length === 0) return { status: 'off', verdicts };
  try {
    const values = await cache.store.mget(keys);
    keys.forEach((key, index) => {
      const verdict = cachedVerdict(values[index], cache.config);
      if (verdict) verdicts.set(key, verdict);
    });
    return { status: verdicts.size > 0 ? 'hit' : 'miss', verdicts };
  } catch (error) {
    warnExceptInTest('[enkrypt-guardrail] verdict cache lookup failed; scanning in full', {
      organization_id: organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'error', verdicts };
  }
}

function withVerdicts(units: KeyedUnit[], verdicts: Map<string, CachedVerdict>): LookedUpUnit[] {
  return units.map(unit => ({
    ...unit,
    verdict: unit.key === null ? null : (verdicts.get(unit.key) ?? null),
  }));
}

/** The first cached block among `units`, if any. */
function cachedBlock(units: LookedUpUnit[]): Exclude<CachedVerdict, 'allow'> | undefined {
  for (const { verdict } of units) {
    if (verdict !== null && verdict !== 'allow') return verdict;
  }
  return undefined;
}

/** The segments whose units all have a cached verdict, and their length joined as in the part. */
function cachedCoverage(
  rendered: string[],
  units: LookedUpUnit[]
): Pick<EnkryptScanCoverage, 'cachedCharacters' | 'cachedSegments'> {
  const uncached = new Set(units.filter(unit => !unit.verdict).map(unit => unit.segment));
  const cached = rendered.filter((_, index) => !uncached.has(index));
  return { cachedCharacters: joinSegments(cached).length, cachedSegments: cached.length };
}

/**
 * The units without a cached verdict, each once, packed into Enkrypt calls. A unit that appears
 * more than once, such as a repeated message, is scanned once.
 */
function uncachedCalls(units: LookedUpUnit[]): KeyedUnit[][] {
  const seen = new Set<string>();
  return packUnits(
    units.filter(unit => {
      const id = unit.key ?? unit.text;
      if (unit.verdict || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
  );
}

/**
 * A log-only scan gates nothing, so its result is cached even when it fails, unless the client
 * disconnected or the scan ran out of time before any call. Otherwise a failure that recurs, such
 * as a timeout, a detector error, or a request too large to scan, would rescan, log, and possibly be
 * charged for the same text on every later request of the conversation. A scan that never got a
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
 * What to cache for the calls of a part: an allowed call caches an allow for each of its units, so
 * after another call fails or runs out of time, the next request rescans only that call's units.
 * Writes are deferred and auto-pipelined, and an allow is never overwritten. Enkrypt does not say
 * which unit of a packed call fired, so a genuine block is cached only for a call of one unit.
 */
function callCacheEntries(
  calls: KeyedUnit[][],
  results: EnkryptGuardrailScanResult[],
  cache: VerdictCache | null
): EnkryptVerdictCacheEntry[] {
  if (!cache) return [];
  return calls.flatMap((call, index): EnkryptVerdictCacheEntry[] => {
    const verdict = cacheableVerdict(required(results[index]), cache.config);
    if (verdict === 'allow') {
      return call.flatMap(({ key }) => (key ? [{ key, verdict }] : []));
    }
    const [only] = call;
    return verdict && call.length === 1 && only?.key ? [{ key: only.key, verdict }] : [];
  });
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
  const first = required(results[0]);
  if (results.length === 1) return first;
  const reports = results.map(result => result.report);
  const bySeverest = [...reports].sort(bySeverity);
  return {
    verdict: mostSevereVerdict(results.map(result => result.verdict)),
    usageRecords: results.flatMap(result => result.usageRecords),
    report: {
      ...first.report,
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

function logFields(request: EnkryptScanContext) {
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
  finish(
    resultOf: (scan: EnkryptGuardrailScan) => EnkryptGuardrailScanResult
  ): EnkryptCachedScanResult;
};

/**
 * A scan for each call, its units joined like segments. With nothing to scan, one scan of no text
 * still reports the part, without an Enkrypt call.
 */
function callScans(
  request: EnkryptScanContext,
  coverage: EnkryptScanCoverage,
  calls: KeyedUnit[][]
): EnkryptGuardrailScan[] {
  if (calls.length === 0) return [{ ...request, text: '', coverage }];
  return calls.map((call, index) => ({
    ...request,
    text: joinSegments(call.map(unit => unit.text)),
    coverage: { ...coverage, chunk: { index, count: calls.length } },
  }));
}

/**
 * Plans the system prompt or the conversation. Each segment, or each slice of a segment too long
 * for one Enkrypt call, has its verdict cached on its own; only the units without one are scanned,
 * packed into as few calls as fit. A cached block of any unit rejects the request. A cache failure
 * scans the part in full, so it never lets unscanned content through. A failed blocking scan is
 * never cached; see `isCacheableAllow` for log-only scans.
 */
async function planSegmentsPart(
  part: 'system' | 'conversation',
  segments: RequestSegment[],
  request: EnkryptScanContext,
  cache: VerdictCache | null
): Promise<PartPlan> {
  const rendered = segments.map(renderSegment);
  const keyed = keyedUnits(request, part, segments, cache);
  const { status, verdicts } = await lookup(request.organizationId, keyed, cache);
  const units = withVerdicts(keyed, verdicts);
  const coverage: EnkryptScanCoverage = {
    part,
    cache: status,
    totalCharacters: joinSegments(rendered).length,
    totalSegments: segments.length,
    ...cachedCoverage(rendered, units),
    omittedAttachments: segments.filter(segment => segment.body === null).length,
  };
  const block = cachedBlock(units);
  if (block && cache) {
    const { config } = cache;
    const { detectors } = block;
    const report: EnkryptInputPartScanReport = {
      scan: 'blocking',
      part,
      detectors_enabled: ENKRYPT_DETECTOR_IDS.filter(id => config.detectors[id] !== undefined),
      detectors_blocking: config.blockingDetectors,
      verdict_cache: 'hit',
      total_characters: coverage.totalCharacters,
      total_segments: coverage.totalSegments,
      cached_characters: coverage.cachedCharacters,
      cached_segments: coverage.cachedSegments,
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
      scans: [],
      finish: () => ({
        verdict: { action: 'block', message: guardrailBlockMessage(detectors, null) },
        usageRecords: [],
        report,
        cacheEntries: [],
      }),
    };
  }
  const calls = uncachedCalls(units);
  const scans = callScans(request, coverage, calls);
  return {
    scans,
    finish(resultOf) {
      const results = scans.map(resultOf);
      const result = combineChunks(results);
      return {
        ...result,
        report: { ...result.report, part, chunks: calls.length },
        cacheEntries: callCacheEntries(calls, results, cache),
      };
    },
  };
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

/** The outcome of one tool definition: its cached verdict, or the scan of its uncached segments. */
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
    verdict_cache: cache,
    tools_total: outcomes.length,
    tools_cached: cached.length,
    tools_scanned: outcomes.length - cached.length,
    tools_flagged: flagged.length,
    total_characters: sum(outcomes.map(each => each.characters)),
    cached_characters:
      sum(cached.map(each => each.characters)) +
      sum(reports.map(report => report.cached_characters)),
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

/** A tool's cached verdict, or the calls that scan its uncached segments. */
type ToolPlan = { tool: RequestToolDefinition; characters: number } & (
  | { verdict: CachedVerdict }
  | { calls: KeyedUnit[][]; scans: EnkryptGuardrailScan[] }
);

/**
 * Plans the tool definitions and response formats. Each segment of each is cached on its own, as
 * for the other parts, so a changed, added, or removed tool rescans only what changed. Each tool
 * with uncached segments is scanned by its own Enkrypt calls, so a detection is reported for the
 * tool that fired it. Each call pays Enkrypt's per-call minimum, so an uncached tool set costs more
 * than one combined call would; verdicts are shared across the organization, so that is paid once
 * per tool and detector set. The results are aggregated into one result for the part: it blocks
 * when any tool blocks, and is otherwise unavailable when any tool's scan is.
 */
async function planTools(
  tools: RequestToolDefinition[],
  request: EnkryptScanContext,
  cache: VerdictCache | null
): Promise<PartPlan> {
  const { config } = request;
  const toolUnits = tools.map(tool => ({
    tool,
    rendered: tool.segments.map(renderSegment),
    units: keyedUnits(request, 'tools', tool.segments, cache),
  }));
  const { status, verdicts } = await lookup(
    request.organizationId,
    toolUnits.flatMap(each => each.units),
    cache
  );
  const plans = toolUnits.map(({ tool, rendered, units: keyed }): ToolPlan => {
    const characters = joinSegments(rendered).length;
    const units = withVerdicts(keyed, verdicts);
    const block = cachedBlock(units);
    if (block) return { tool, characters, verdict: block };
    if (units.every(unit => unit.verdict === 'allow')) {
      return { tool, characters, verdict: 'allow' };
    }
    const calls = uncachedCalls(units);
    const coverage: EnkryptScanCoverage = {
      part: 'tools',
      cache: status,
      totalCharacters: characters,
      totalSegments: tool.segments.length,
      ...cachedCoverage(rendered, units),
      omittedAttachments: 0,
    };
    return { tool, characters, calls, scans: callScans(request, coverage, calls) };
  });
  return {
    scans: plans.flatMap(plan => ('scans' in plan ? plan.scans : [])),
    finish(resultOf) {
      const outcomes = plans.map((plan): ToolOutcome => {
        const { tool, characters } = plan;
        if ('verdict' in plan) {
          return { tool, characters, outcome: { kind: 'cached', verdict: plan.verdict } };
        }
        const results = plan.scans.map(resultOf);
        return {
          tool,
          characters,
          outcome: {
            kind: 'scanned',
            result: combineChunks(results),
            cacheEntries: callCacheEntries(plan.calls, results, cache),
          },
        };
      });
      const report = toolsReport(scanKind(config), config, status, outcomes);
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
 * Every verdict cache lookup finishes before any scan starts. The calls then start longest text
 * first, so with `deps.limiter` capping concurrent calls the long ones do not run last and hold up
 * the verdict. Each allowed call is cached on its own, so when the deadline cuts a long
 * conversation short, the next request rescans only the calls that did not finish. They share one
 * deadline, started before the lookups, which includes time spent waiting for a call slot, so the
 * part results arrive within `deps.timeoutMs` plus the lookup.
 */
export async function scanRequestWithVerdictCache(
  { parts, ...request }: EnkryptGuardrailRequest,
  { store, ...deps }: ScanDependencies
): Promise<EnkryptCachedScanResult[]> {
  const scanDeps: EnkryptDetectDependencies = {
    ...deps,
    deadline: deps.deadline ?? AbortSignal.timeout(deps.timeoutMs),
  };
  const { config } = request;
  const cache = store && config.status === 'ready' ? { store, config } : null;
  const plans = await Promise.all([
    ...(parts.tools.length > 0 ? [planTools(parts.tools, request, cache)] : []),
    ...(parts.system.length > 0 ? [planSegmentsPart('system', parts.system, request, cache)] : []),
    planSegmentsPart('conversation', parts.conversation, request, cache),
  ]);
  const byLength = plans.flatMap(plan => plan.scans).sort((a, b) => b.text.length - a.text.length);
  const results = new Map(
    await Promise.all(
      byLength.map(async scan => [scan, await scanRequest(scan, scanDeps)] as const)
    )
  );
  return plans.map(plan => plan.finish(scan => required(results.get(scan))));
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

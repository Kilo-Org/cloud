/**
 * Code Reviewer Council — core, pure logic (single-session model).
 *
 * Dependency-light on purpose (`zod` + `@kilocode/db/schema-types` only) so both the
 * web app and the `code-review-infra` worker can import it without duplicating logic.
 *
 * Scope: the settled, capture-agnostic pieces — the code-owned governance DECISION,
 * the per-specialist result contract (findings only; votes are DERIVED), the single-session
 * combined result manifest + parser, specialist presets, and the automated review-type stub.
 * Prompt builders (web) and execution wiring (worker/DO, runtimeAgents) live with their
 * callers, not here.
 *
 * v2: the model reports FACTS only (findings + a fixed severity per finding). Code derives
 * each specialist's BINARY vote (any critical finding → block), then computes the aggregate
 * decision per the governance mode (advisory → no decision; unanimous/majority → block/pass).
 * The model never authors a vote, decision, or verdict.
 */

import * as z from 'zod';
import {
  COUNCIL_BLOCKING_SEVERITY,
  COUNCIL_FINDING_SEVERITIES,
  DEFAULT_COUNCIL_AGGREGATION_STRATEGY,
  CouncilFindingSchema,
  type CodeReviewCouncilConfig,
  type CodeReviewType,
  type CouncilAggregationStrategy,
  type CouncilFinding,
  type CouncilSpecialist,
  type CouncilSpecialistRole,
  type CouncilVote,
} from '@kilocode/db/schema-types';

// ============================================================================
// Governance decision (code-owned, deterministic) — v2
// ============================================================================

/** A specialist's BINARY vote as seen by aggregation (code-derived, never model-authored). */
export type SpecialistVote = { specialistId: string; vote: CouncilVote };

// Ranking derived from the canonical scale (index 0 = most severe) so it can never drift from
// COUNCIL_FINDING_SEVERITIES: extend/reorder the scale and the ranking follows automatically.
// Off-scale labels rank 0 (below the whole scale).
const SEVERITY_RANK: Record<string, number> = Object.fromEntries(
  COUNCIL_FINDING_SEVERITIES.map((severity, index) => [
    severity,
    COUNCIL_FINDING_SEVERITIES.length - index,
  ])
);

function severityRank(severity: string): number {
  return SEVERITY_RANK[severity.trim().toLowerCase()] ?? 0;
}

/** Whether a finding severity counts as BLOCKING (the canonical `COUNCIL_BLOCKING_SEVERITY`).
 * Case/space-insensitive. */
export function isBlockingSeverity(severity: string | null | undefined): boolean {
  return (severity ?? '').trim().toLowerCase() === COUNCIL_BLOCKING_SEVERITY;
}

/**
 * The highest-severity label present in a specialist's findings (original casing preserved),
 * or null if there are none. Ranks off the canonical scale; unknown labels rank lowest.
 */
export function highestSeverityOf(findings: readonly CouncilFinding[]): string | null {
  let top: string | null = null;
  let topRank = 0;
  for (const finding of findings) {
    const rank = severityRank(finding.severity);
    if (rank > topRank || (rank === 0 && top === null)) {
      topRank = rank;
      top = finding.severity;
    }
  }
  return top;
}

/**
 * Derives a specialist's BINARY vote from its findings — code-owned, never model-authored.
 * Any finding at the blocking severity (`critical`) → `block`; otherwise (including zero
 * findings — "I ran and found nothing") → `pass`. This is the "a member votes yes/no, not
 * 'warning'" rule: severity is the model's judgment, the vote follows deterministically.
 */
export function deriveSpecialistVote(findings: readonly CouncilFinding[]): CouncilVote {
  return findings.some(finding => isBlockingSeverity(finding.severity)) ? 'block' : 'pass';
}

/**
 * Computes the aggregate council decision from the collected BINARY specialist votes.
 * Only the enforcing modes are valid here ('unanimous' | 'majority'); 'advisory' produces
 * NO decision and is handled by `decideCouncilFromManifest`.
 *
 * - `unanimous` — block unless every specialist voted pass (any block → block). Strict.
 * - `majority`  — block only when block votes outnumber pass votes. Lenient (ties → pass).
 *
 * Empty votes → `block` (never pass on absent coverage). Missing-configured-specialist
 * coverage is enforced separately in `decideCouncilFromManifest`.
 */
export function computeCouncilDecision(
  votes: readonly SpecialistVote[],
  strategy: Exclude<CouncilAggregationStrategy, 'advisory'>
): CouncilVote {
  if (votes.length === 0) return 'block'; // no usable coverage → never pass
  const blockCount = votes.filter(vote => vote.vote === 'block').length;
  const passCount = votes.length - blockCount;
  switch (strategy) {
    case 'majority':
      return blockCount > passCount ? 'block' : 'pass';
    case 'unanimous':
    default:
      return blockCount > 0 ? 'block' : 'pass';
  }
}

/**
 * Whether a governance decision should block merge. `block` blocks; `pass` and `null`
 * (advisory — no verdict) do not.
 */
export function councilDecisionBlocksMerge(decision: CouncilVote | null): boolean {
  return decision === 'block';
}

// ============================================================================
// Per-specialist result contract + single-session combined manifest
// ============================================================================

/**
 * One finding reported by a specialist. The shape is the shared `CouncilFindingSchema`
 * from `@kilocode/db/schema-types` (single source of truth for parse + storage);
 * re-exported here under the council-manifest name for callers of this module.
 */
export { CouncilFindingSchema as CouncilSpecialistFindingSchema } from '@kilocode/db/schema-types';
export type CouncilSpecialistFinding = CouncilFinding;

/**
 * One specialist's structured result (v2). The model reports ONLY facts: `findings` (each
 * with a severity from the canonical scale). It does NOT report a vote — the vote is
 * code-derived from the findings (`deriveSpecialistVote`), as is `highestSeverity`. `findings`
 * is required and severities must be on-scale (both fail closed if not); only `model` is
 * lenient (a missing model does not invalidate the manifest).
 */
export const CouncilSpecialistResultSchema = z.object({
  specialistId: z.string().min(1).max(64),
  // REQUIRED (no default): an entry must explicitly carry its findings array — `[]` means
  // "reviewed, nothing blocking" (→ pass). A missing `findings` key is ambiguous (truncated
  // report vs. clean) and must NOT silently derive to pass, so it invalidates the manifest →
  // the decision fails closed. The coordinator prompt requires `findings` on every entry.
  findings: z.array(CouncilFindingSchema).max(200),
  // Best-effort: the concrete model this specialist actually ran on, as reported back by
  // the specialist itself. We assign a model per specialist, but an "auto" slug (e.g.
  // `kilo-auto/...`) resolves to a concrete model at runtime inside cloud-agent-next, which
  // the web side never sees otherwise. Lenient/optional (a missing model must NOT invalidate
  // the manifest); capture falls back to the configured per-specialist model when absent.
  model: z.string().max(200).nullable().optional(),
});
export type CouncilSpecialistResult = z.infer<typeof CouncilSpecialistResultSchema>;

/**
 * Marker tag for the single-session combined council manifest. The orchestrator emits
 * ONE of these in its final message, carrying every specialist's findings. v2 dropped the
 * model-authored `vote` (code derives it), so the shape changed → the tag version bumped.
 */
export const COUNCIL_RESULT_MARKER_TAG = 'kilo-code-review-council:v2';

/** Hard cap on the manifest JSON payload (UTF-8 bytes) to bound parsing cost. */
export const COUNCIL_RESULT_MAX_BYTES = 128 * 1024;

/**
 * The combined council manifest: one array of per-specialist results. This is the
 * single-session capture shape; our code parses it and computes the decision.
 *
 * `specialistId` must be unique across the array. A duplicate is a coverage-integrity
 * violation: without this, a `Map`-based reconcile would silently keep the last entry,
 * letting a later `{id: pass}` override an earlier `{id: block}`. Rejecting duplicates
 * here makes such a manifest INVALID (→ no coverage → the decision fails closed), and
 * keeps the computed decision in agreement with `summarizeCouncilManifest` (which
 * iterates the raw array).
 */
export const CouncilResultManifestSchema = z.object({
  specialists: z
    .array(CouncilSpecialistResultSchema)
    .max(8)
    .superRefine((specialists, ctx) => {
      const seen = new Set<string>();
      for (const specialist of specialists) {
        if (seen.has(specialist.specialistId)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate specialistId: ${specialist.specialistId}`,
          });
          return;
        }
        seen.add(specialist.specialistId);
      }
    }),
});
export type CouncilResultManifest = z.infer<typeof CouncilResultManifestSchema>;

/**
 * Result of attempting to capture the combined council manifest from the orchestrator's
 * final message. `missing` = no marker present; `invalid` = marker present but
 * unparseable / failed schema. Both non-captured states must be treated as NO coverage
 * downstream (→ `computeCouncilDecision` blocks), never as an implicit pass.
 */
export type CouncilManifestCapture =
  | { status: 'captured'; manifest: CouncilResultManifest }
  | { status: 'missing' }
  | { status: 'invalid' };

/**
 * Whether the UTF-8 byte length of `str` exceeds `limit`, computed incrementally with an
 * early exit so we never allocate a full byte array just to measure (important for a
 * Worker handling untrusted model output).
 */
function utf8ByteLengthExceeds(str: string, limit: number): boolean {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: only a valid pair (followed by a low surrogate) is one 4-byte
      // code point. An unpaired high surrogate is encoded as the 3-byte replacement
      // character (U+FFFD) and does NOT consume the next unit — matching TextEncoder.
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3; // BMP char, or an unpaired low surrogate (3-byte replacement char)
    if (bytes > limit) return true;
  }
  return false;
}

/**
 * Balanced-brace scan from `open`, honoring JSON string literals and escapes, returning
 * the JSON object substring (inclusive of its braces) or null if never balanced. Because
 * it tracks string state, a `-->` or `}` inside a string value does not truncate it.
 *
 * The scan is bounded: it aborts (returns null) once it has traversed more than `maxChars`
 * characters, so an oversized untrusted payload cannot cause unbounded scanning or
 * materialize an oversized slice. `maxChars` is a byte budget used as a character bound;
 * since a string's byte length is >= its character length, a payload within the byte cap
 * is never aborted, and one that would exceed the cap in characters certainly exceeds it
 * in bytes (fail closed either way — both null results are treated as invalid upstream).
 */
function scanBalancedJson(text: string, open: number, maxChars: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    if (i - open > maxChars) return null; // oversized — abort before allocating a slice
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return null; // unbalanced
}

/**
 * Extracts the balanced JSON payload of the LAST top-level marker (`<!-- TAG {json} -->`)
 * in free text. "Top-level" = the marker starts its own line (only leading horizontal
 * whitespace before `<!--`).
 *
 * Robustness properties:
 * - **Embedded-marker safety (structural):** the orchestrator emits the marker on its own
 *   final line, and `JSON.stringify` escapes `\n`/`\r`, so marker text quoted inside a
 *   finding's JSON string is NEVER at the start of a real line. Anchoring to a real line
 *   break therefore excludes embedded occurrences structurally. NOTE: we deliberately do
 *   NOT use `^` with the `m` flag — JS also treats U+2028/U+2029 as line terminators for
 *   `^m`, but those can appear UNESCAPED inside JSON strings, so an `^m` anchor would let
 *   a finding containing `\u2028<!-- tag` masquerade as a top-level marker. We anchor only
 *   to `\n`/`\r` (or start-of-text).
 * - **Version isolation:** the tag must be followed by horizontal whitespace, so a longer
 *   version like `${tag}0` / `${tag}junk` is NOT matched as `tag`.
 * - **`-->`/`}` tolerance:** the JSON is read by a string-aware brace scan, so those chars
 *   inside a finding's text do not truncate it.
 *
 * Only the LAST such marker is scanned (single pass), and callers validate it
 * authoritatively — a malformed/oversized latest marker stays invalid rather than falling
 * back to an earlier one (fail closed, last-marker-wins). `tagPresent` distinguishes "no
 * marker" (missing) from "marker present but no balanced JSON" (invalid).
 */
function extractLastMarkerJson(
  text: string,
  tag: string
): { tagPresent: boolean; json: string | null } {
  const starter = new RegExp(`<!--[ \\t]*${tag}[ \\t]+`, 'g');
  let searchFrom = -1;
  for (const match of text.matchAll(starter)) {
    // Top-level = only horizontal whitespace between this `<!--` and a real line break
    // (`\n`/`\r`) or start-of-text. Skip mid-line occurrences (embedded in a finding).
    let p = match.index - 1;
    while (p >= 0 && (text[p] === ' ' || text[p] === '\t')) p--;
    if (p >= 0 && text[p] !== '\n' && text[p] !== '\r') continue;
    searchFrom = match.index + match[0].length;
  }
  if (searchFrom < 0) return { tagPresent: false, json: null };

  // The JSON object must begin immediately after the tag (the `[ \t]+` above consumed the
  // separating whitespace). Do NOT scan ahead for a `{` — otherwise a malformed marker
  // with no payload could swallow unrelated JSON later in the message.
  if (text[searchFrom] !== '{') return { tagPresent: true, json: null };
  const json = scanBalancedJson(text, searchFrom, COUNCIL_RESULT_MAX_BYTES);
  if (json === null) return { tagPresent: true, json: null };

  // Require the marker to be framed: optional horizontal whitespace then its closing
  // `-->` immediately after the balanced object. This confirms the object belongs to this
  // marker rather than being loose JSON that merely follows the tag.
  let after = searchFrom + json.length;
  while (text[after] === ' ' || text[after] === '\t') after++;
  if (text.slice(after, after + 3) !== '-->') return { tagPresent: true, json: null };

  return { tagPresent: true, json };
}

/**
 * Extracts and validates the combined council manifest from the orchestrator's final
 * message.
 *
 * The LAST top-level marker (see `extractLastMarkerJson`) is authoritative — real models
 * add a trailing sentence after the marker, but a later marker supersedes an earlier one.
 * The JSON is read by a brace-aware scan, so `-->`/`}` inside a finding's text does not
 * truncate it, and marker text quoted inside a finding is excluded structurally (it is not
 * at line start). A malformed or oversized latest marker stays `invalid` (fail closed) —
 * it never falls back to an earlier result. Schema is strict only where it must be
 * (each specialist's `vote`).
 */
export function parseCouncilResultManifest(
  text: string | null | undefined
): CouncilManifestCapture {
  if (!text) return { status: 'missing' };

  const { tagPresent, json } = extractLastMarkerJson(text, COUNCIL_RESULT_MARKER_TAG);
  if (!tagPresent) return { status: 'missing' };
  if (json === null) return { status: 'invalid' };
  if (utf8ByteLengthExceeds(json, COUNCIL_RESULT_MAX_BYTES)) return { status: 'invalid' };

  try {
    const parsed: unknown = JSON.parse(json);
    const result = CouncilResultManifestSchema.safeParse(parsed);
    return result.success ? { status: 'captured', manifest: result.data } : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

/** Per-specialist rollup for the Kilo UI: vote, highest severity, and findings count. */
export type CouncilSpecialistSummary = {
  specialistId: string;
  vote: CouncilVote;
  highestSeverity: string | null;
  findingsCount: number;
};

/** Summarizes each specialist's result (findings count included) for UI display. Vote and
 * highest severity are DERIVED from the findings (the model reports neither). */
export function summarizeCouncilManifest(
  manifest: CouncilResultManifest
): CouncilSpecialistSummary[] {
  return manifest.specialists.map(specialist => ({
    specialistId: specialist.specialistId,
    vote: deriveSpecialistVote(specialist.findings),
    highestSeverity: highestSeverityOf(specialist.findings),
    findingsCount: specialist.findings.length,
  }));
}

/** Coverage of a captured manifest against the specialists we asked to run. */
export type CouncilCoverage = {
  /** One entry per configured specialist that actually reported a result. */
  votes: SpecialistVote[];
  /**
   * Configured specialists without a single reliable result — either absent from the
   * manifest (dropped), or reported more than once (duplicate/ambiguous). Both are
   * treated as no coverage so the decision fails closed.
   */
  missingSpecialistIds: string[];
};

/**
 * Reconciles a captured manifest against the specialists we ASKED to run. Reported
 * votes are returned as-is (a real returned `abstain` stays `abstain`); configured
 * specialists absent from the manifest are surfaced separately in `missingSpecialistIds`
 * rather than being laundered into an `abstain` vote. Manifest entries for specialists
 * we did not configure are ignored. Callers enforce coverage via `decideCouncilFromManifest`.
 *
 * Defense in depth (fail closed on ambiguity):
 * - `CouncilResultManifestSchema` already rejects duplicate REPORTED ids at parse time,
 *   but if a manifest is constructed without the parser, a specialist reported MORE THAN
 *   ONCE is treated as missing rather than letting a `Map` silently keep the last vote.
 * - A duplicate CONFIGURED id is a config-integrity violation (a specialist must not vote
 *   twice — otherwise duplicating a passing specialist could flip a majority). Each
 *   duplicated configured id is counted once and treated as missing coverage.
 */
export function reconcileCouncilVotes(
  configuredSpecialistIds: readonly string[],
  manifest: CouncilResultManifest
): CouncilCoverage {
  const configuredSeen = new Set<string>();
  const duplicateConfigured = new Set<string>();
  for (const specialistId of configuredSpecialistIds) {
    if (configuredSeen.has(specialistId)) duplicateConfigured.add(specialistId);
    configuredSeen.add(specialistId);
  }

  const counts = new Map<string, number>();
  for (const specialist of manifest.specialists) {
    counts.set(specialist.specialistId, (counts.get(specialist.specialistId) ?? 0) + 1);
  }
  const reported = new Map(manifest.specialists.map(s => [s.specialistId, s]));

  const votes: SpecialistVote[] = [];
  const missingSpecialistIds: string[] = [];
  // Iterate the DEDUPED configured ids so a specialist is never counted more than once.
  for (const specialistId of configuredSeen) {
    const specialist = reported.get(specialistId);
    // Reliable coverage requires exactly one configured entry AND exactly one report.
    if (
      !duplicateConfigured.has(specialistId) &&
      counts.get(specialistId) === 1 &&
      specialist !== undefined
    ) {
      // The vote is DERIVED from the reported findings, never model-authored.
      votes.push({ specialistId, vote: deriveSpecialistVote(specialist.findings) });
    } else {
      missingSpecialistIds.push(specialistId);
    }
  }
  return { votes, missingSpecialistIds };
}

/** A council decision plus the coverage that produced it. `decision` is null in advisory mode. */
export type CouncilDecision = {
  decision: CouncilVote | null;
  votes: SpecialistVote[];
  missingSpecialistIds: string[];
};

/**
 * The deterministic, coverage-aware council decision — the entry point callers should
 * use to decide from a captured manifest.
 *
 * COVERAGE INTEGRITY (fail closed): if ANY configured specialist has no captured result
 * (`missingSpecialistIds` is non-empty), the decision is `block` regardless of strategy.
 * We cannot vouch for a dimension we never got a result for, so a dropped/lost specialist
 * can never silently let the council pass. Only when every configured specialist reported
 * does the decision defer to `computeCouncilDecision` over the reported votes.
 *
 * Note: a failed capture (`parseCouncilResultManifest` returned `missing`/`invalid`)
 * means NO coverage at all — callers must treat that as `block` (e.g. pass an empty
 * manifest, which yields all-missing → block).
 */
export function decideCouncilFromManifest(
  configuredSpecialistIds: readonly string[],
  manifest: CouncilResultManifest,
  strategy: CouncilAggregationStrategy
): CouncilDecision {
  const { votes, missingSpecialistIds } = reconcileCouncilVotes(configuredSpecialistIds, manifest);
  // Advisory: report the derived votes but compute NO aggregate verdict and no gate.
  if (strategy === 'advisory') {
    return { decision: null, votes, missingSpecialistIds };
  }
  if (missingSpecialistIds.length > 0) {
    return { decision: 'block', votes, missingSpecialistIds };
  }
  return {
    decision: computeCouncilDecision(votes, strategy),
    votes,
    missingSpecialistIds,
  };
}

// (v1's display-only "kilo-review-governance:v1" marker was removed in v2: the model no
// longer authors votes/decisions, so there is nothing model-reported to render from a
// separate marker. Per-specialist votes are DERIVED from the manifest findings.)

// ============================================================================
// Council config helpers
// ============================================================================

/** Enabled specialists in a council config. */
export function enabledSpecialists(council: CodeReviewCouncilConfig): CouncilSpecialist[] {
  return council.specialists.filter(specialist => specialist.enabled);
}

/**
 * Whether there is a runnable council definition: enabled, with at least
 * `COUNCIL_MIN_SPECIALISTS` enabled specialists. A council below the minimum must not
 * render or execute as a council (it falls back to a standard review). This only guards
 * whether the council is renderable — whether a run IS a council run is recorded per-run
 * via `review_type`, not inferred here.
 */
export function isCouncilActive(council: CodeReviewCouncilConfig | undefined | null): boolean {
  return (
    !!council && council.enabled && enabledSpecialists(council).length >= COUNCIL_MIN_SPECIALISTS
  );
}

const AGGREGATION_STRATEGY_LABELS: Record<CouncilAggregationStrategy, string> = {
  advisory: 'Advisory (report only)',
  unanimous: 'Unanimous',
  majority: 'Majority',
};

/** Display label for a governance mode (falls back to the safe-default label). */
export function formatAggregationStrategy(strategy: string | null | undefined): string {
  if (!strategy) return AGGREGATION_STRATEGY_LABELS[DEFAULT_COUNCIL_AGGREGATION_STRATEGY];
  return AGGREGATION_STRATEGY_LABELS[strategy as CouncilAggregationStrategy] ?? strategy;
}

// ============================================================================
// Specialist presets
// ============================================================================

export type CouncilSpecialistPreset = {
  id: string;
  role: CouncilSpecialistRole;
  name: string;
  lens: string;
};

export const COUNCIL_SPECIALIST_PRESETS: CouncilSpecialistPreset[] = [
  {
    id: 'security',
    role: 'security',
    name: 'Security',
    lens: 'Injection, auth/authorization bypass, secret handling, unsafe deserialization, SSRF, and data exposure.',
  },
  {
    id: 'performance',
    role: 'performance',
    name: 'Performance',
    lens: 'Hot paths, N+1 queries, unnecessary allocations, blocking I/O, and algorithmic complexity regressions.',
  },
  {
    id: 'testing',
    role: 'testing',
    name: 'Test coverage',
    lens: 'Missing or weak tests for new behavior, untested edge cases, and regressions lacking coverage.',
  },
  {
    id: 'correctness',
    role: 'correctness',
    name: 'Correctness',
    lens: 'Logic errors, incorrect edge-case handling, race conditions, and broken invariants.',
  },
];

/** Council must have at least this many specialists selected when enabled. */
export const COUNCIL_MIN_SPECIALISTS = 2;

/** Converts a preset into a persistable specialist (enabled, default model/effort). */
export function presetToSpecialist(preset: CouncilSpecialistPreset): CouncilSpecialist {
  return {
    id: preset.id,
    role: preset.role,
    name: preset.name,
    enabled: true,
    // No required/optional distinction: every configured specialist is a voting member.
    required: false,
    lens: preset.lens,
  };
}

// ============================================================================
// Automated (webhook) review-type determination
// ============================================================================

/**
 * Full PR fact set piped into Code Reviewer for automated (webhook) reviews. The
 * automated review-type determination must be made Kilo-side from these facts, not by
 * trusting a dev-controlled SCM label. Kept intentionally open/extensible.
 */
export type AutomatedReviewPrFacts = {
  isDraft?: boolean;
  labels?: string[];
  baseRef?: string;
  changedFileCount?: number;
  changedLineCount?: number;
  author?: string;
};

/**
 * Determines the review type for an AUTOMATED (webhook) run from PR facts.
 *
 * STUB (intentional, phased plan): the real standard-vs-council determination is later
 * work — it must be configured/evaluated Kilo-side and resistant to SCM-side abuse (a
 * dev must not be able to force paid council reviews via a PR label). For now this is a
 * safe stub that always returns `'standard'`, so automated reviews behave exactly as
 * they do today. The plumbing (passing full PR facts + `councilAvailable`) is defined
 * here so the logic can be filled in at the webhook step without further wiring.
 *
 * Manual runs never call this — they carry an explicit user-selected review type.
 */
export function determineAutomatedReviewType(
  _prFacts: AutomatedReviewPrFacts,
  _options: { councilAvailable: boolean }
): CodeReviewType {
  return 'standard';
}

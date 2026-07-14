/**
 * Code Reviewer Council — core, pure logic (single-session model).
 *
 * Dependency-light on purpose (`zod` + `@kilocode/db/schema-types` only) so both the
 * web app and the `code-review-infra` worker can import it without duplicating logic.
 *
 * Scope: the settled, capture-agnostic pieces — the code-owned governance DECISION,
 * the per-specialist result contract (vote + findings), the single-session combined
 * result manifest + parser, the display-only governance marker, specialist presets,
 * and the automated review-type stub. Prompt builders (web) and execution wiring
 * (worker/DO, runtimeAgents) live with their callers, not here.
 *
 * The council runs as ONE cloud-agent session: an orchestrator delegates to one
 * sub-agent per specialist (each pinned to its own model via `runtimeAgents[]`), then
 * relays every specialist's structured result in its final message. Our code — never
 * the model — computes the decision from the collected votes.
 */

import * as z from 'zod';
import {
  CouncilVoteSchema,
  type CodeReviewCouncilConfig,
  type CodeReviewType,
  type CouncilAggregationStrategy,
  type CouncilSpecialist,
  type CouncilSpecialistRole,
  type CouncilVote,
} from '@kilocode/db/schema-types';

// ============================================================================
// Governance decision (code-owned, deterministic)
// ============================================================================

/** A specialist's vote as seen by aggregation. */
export type SpecialistVote = { specialistId: string; vote: CouncilVote };

/**
 * Computes the council governance decision from the collected specialist votes using
 * the selected strategy. This is the deterministic, code-owned replacement for asking
 * the model to compute the decision. The semantics MUST stay in lockstep with
 * `describeAggregationStrategy` (the prompt text the specialists/orchestrator see).
 *
 * Abstain semantics (deliberate): a returned `abstain` vote is treated leniently — it
 * is NOT counted under `any_blocking_member` or `majority` (so a specialist that ran
 * but had nothing to flag does not force a block), and only `unanimous_required`
 * blocks on it. The one universal guard is total no-coverage: if there is no usable
 * vote at all (empty, or every specialist abstained), the decision is `block` for
 * every strategy (never pass on absent coverage).
 *
 * IMPORTANT: this operates only on the votes it is GIVEN. It does NOT know which
 * specialists were configured, so it cannot detect a missing/dropped specialist. That
 * coverage-integrity guard (missing configured specialist → block regardless of
 * strategy) lives in `decideCouncilFromManifest`, which callers should use when
 * deciding from a captured manifest.
 */
export function computeCouncilDecision(
  votes: readonly SpecialistVote[],
  strategy: CouncilAggregationStrategy
): CouncilVote {
  const counts = { pass: 0, warn: 0, block: 0, abstain: 0 } satisfies Record<CouncilVote, number>;
  for (const { vote } of votes) counts[vote]++;

  // No usable signal (empty, or every specialist abstained) => never pass.
  if (counts.pass + counts.warn + counts.block === 0) return 'block';

  const anyWarn = counts.warn > 0;

  switch (strategy) {
    case 'majority': {
      if (counts.block > counts.pass) return 'block';
      return anyWarn ? 'warn' : 'pass';
    }
    case 'unanimous_required': {
      if (counts.block > 0 || counts.abstain > 0) return 'block';
      return anyWarn ? 'warn' : 'pass';
    }
    case 'any_blocking_member':
    default: {
      if (counts.block > 0) return 'block';
      return anyWarn ? 'warn' : 'pass';
    }
  }
}

/**
 * Whether a governance decision should block merge. `block` always blocks; `warn` is
 * non-blocking here (warning-as-blocking is a separate gate-threshold policy).
 */
export function councilDecisionBlocksMerge(decision: CouncilVote): boolean {
  return decision === 'block';
}

/** Human-readable governance rule text so the orchestrator applies the SELECTED strategy.
 * Every configured specialist is a voting member; all votes count equally. Keep the
 * wording in lockstep with `computeCouncilDecision`. */
export function describeAggregationStrategy(strategy: CouncilAggregationStrategy): string {
  // Every strategy blocks when there is no usable coverage (no votes at all, or every
  // specialist abstained) — this MUST match the guard in `computeCouncilDecision`.
  const noCoverageRule =
    ' If no specialist produced a usable vote (all abstained, or no votes at all), the decision is block.';
  switch (strategy) {
    case 'majority':
      return `Majority: count votes across all specialists. If block votes outnumber pass votes, the decision is block. Otherwise, if any specialist voted warn, the decision is warn. Otherwise pass.${noCoverageRule}`;
    case 'unanimous_required':
      return `Unanimous: every specialist must vote pass. If any specialist voted block or abstain, the decision is block. Otherwise, if any specialist voted warn, the decision is warn. Otherwise pass.${noCoverageRule}`;
    case 'any_blocking_member':
    default:
      return `Any blocking member: if any specialist voted block, the decision is block. Otherwise, if any specialist voted warn, the decision is warn. Otherwise pass.${noCoverageRule}`;
  }
}

// ============================================================================
// Per-specialist result contract + single-session combined manifest
// ============================================================================

/**
 * One finding reported by a specialist. Lenient by design: `severity` is a free-form
 * display label (severity vocabularies vary), `line` is optional/nullable, and
 * `rationale`/`path` are length-bounded but not otherwise constrained.
 */
export const CouncilSpecialistFindingSchema = z.object({
  path: z.string().max(1024),
  line: z.number().int().nonnegative().nullable().optional(),
  severity: z.string().max(64),
  rationale: z.string().max(4000),
});
export type CouncilSpecialistFinding = z.infer<typeof CouncilSpecialistFindingSchema>;

/**
 * One specialist's structured result. STRICT only on `vote` (the load-bearing value
 * the code-side decision depends on); findings + severity are lenient. `findings` is
 * the full list surfaced in the Kilo UI and published to the PR.
 */
export const CouncilSpecialistResultSchema = z.object({
  specialistId: z.string().min(1).max(64),
  vote: CouncilVoteSchema,
  highestSeverity: z.string().max(64).nullable().optional(),
  findings: z.array(CouncilSpecialistFindingSchema).max(200).default([]),
});
export type CouncilSpecialistResult = z.infer<typeof CouncilSpecialistResultSchema>;

/**
 * Marker tag for the single-session combined council manifest. The orchestrator emits
 * ONE of these in its final message, carrying every specialist's result. (One marker
 * + strict schema is more deterministic than N scattered per-specialist markers.)
 */
export const COUNCIL_RESULT_MARKER_TAG = 'kilo-code-review-council:v1';

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

/** Summarizes each specialist's result (findings count included) for UI display. */
export function summarizeCouncilManifest(
  manifest: CouncilResultManifest
): CouncilSpecialistSummary[] {
  return manifest.specialists.map(specialist => ({
    specialistId: specialist.specialistId,
    vote: specialist.vote,
    highestSeverity: specialist.highestSeverity ?? null,
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
  const reported = new Map(manifest.specialists.map(s => [s.specialistId, s.vote]));

  const votes: SpecialistVote[] = [];
  const missingSpecialistIds: string[] = [];
  // Iterate the DEDUPED configured ids so a specialist is never counted more than once.
  for (const specialistId of configuredSeen) {
    const vote = reported.get(specialistId);
    // Reliable coverage requires exactly one configured entry AND exactly one report.
    if (
      !duplicateConfigured.has(specialistId) &&
      counts.get(specialistId) === 1 &&
      vote !== undefined
    ) {
      votes.push({ specialistId, vote });
    } else {
      missingSpecialistIds.push(specialistId);
    }
  }
  return { votes, missingSpecialistIds };
}

/** A council decision plus the coverage that produced it. */
export type CouncilDecision = {
  decision: CouncilVote;
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
  if (missingSpecialistIds.length > 0) {
    return { decision: 'block', votes, missingSpecialistIds };
  }
  return { decision: computeCouncilDecision(votes, strategy), votes, missingSpecialistIds };
}

// ============================================================================
// Governance marker (display-only human-readable summary)
// ============================================================================

/** Marker tag for the human-readable governance summary. Display-only: it is NOT the
 * source of the decision (our code computes that via `computeCouncilDecision`). */
export const GOVERNANCE_MARKER_TAG = 'kilo-review-governance:v1';

const GovernanceMemberSchema = z.object({
  id: z.string(),
  vote: CouncilVoteSchema,
  // Display-only label; accept any wording the model emits (e.g. "low", "info",
  // "none") so a severity vocabulary mismatch never rejects the whole marker.
  highestSeverity: z
    .string()
    .max(50)
    .nullable()
    .optional()
    .transform(value => (value && value.toLowerCase() !== 'none' ? value : null)),
  reason: z.string().max(1000).optional(),
});

// The overall `decision` is deliberately NOT part of this schema: it is code-owned
// (`computeCouncilDecision`), and a model-authored decision here could contradict it in
// the UI. Consumers render the per-member votes from this marker and inject the computed
// decision. Any `decision` key the model emits is ignored (non-strict object strips it).
export const GovernanceSchema = z.object({
  members: z.array(GovernanceMemberSchema).max(8),
});
export type Governance = z.infer<typeof GovernanceSchema>;
export type GovernanceMember = z.infer<typeof GovernanceMemberSchema>;

/**
 * Extracts and validates the display-only governance marker (per-member votes/reasons)
 * from an assistant message. Returns null when absent or malformed. This drives display
 * only; the overall merge decision comes from `computeCouncilDecision`, never from here.
 */
export function parseGovernanceMarker(text: string | null | undefined): Governance | null {
  if (!text) return null;
  // Same line-anchored, brace-aware, size-capped extraction as the manifest parser.
  const { json } = extractLastMarkerJson(text, GOVERNANCE_MARKER_TAG);
  if (json === null) return null;
  if (utf8ByteLengthExceeds(json, COUNCIL_RESULT_MAX_BYTES)) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    const result = GovernanceSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

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
  any_blocking_member: 'Any blocking member',
  majority: 'Majority',
  unanimous_required: 'Unanimous required',
};

/** Display label for an aggregation strategy (falls back to the default label). */
export function formatAggregationStrategy(strategy: string | null | undefined): string {
  if (!strategy) return AGGREGATION_STRATEGY_LABELS.any_blocking_member;
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

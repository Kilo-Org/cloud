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

/**
 * A specialist's vote as seen by aggregation. A specialist whose result could not be
 * captured contributes `abstain` (abstain-never-pass), so a lost/garbled result can
 * never silently produce a passing council decision.
 */
export type SpecialistVote = { specialistId: string; vote: CouncilVote };

/**
 * Computes the council governance decision from the collected specialist votes using
 * the selected strategy. This is the deterministic, code-owned replacement for asking
 * the model to compute the decision. The semantics MUST stay in lockstep with
 * `describeAggregationStrategy` (the prompt text the specialists/orchestrator see).
 *
 * When there is no usable coverage — no votes at all, OR every specialist abstained —
 * the decision is `block` for every strategy (never pass on absent coverage). This
 * subsumes abstain-never-pass: a lost/garbled result contributes `abstain`, and if
 * that is all we have, the council blocks.
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
  switch (strategy) {
    case 'majority':
      return 'Majority: count votes across all specialists. If block votes outnumber pass votes, the decision is block. Otherwise, if any specialist voted warn, the decision is warn. Otherwise pass.';
    case 'unanimous_required':
      return 'Unanimous: every specialist must vote pass. If any specialist voted block or abstain, the decision is block. Otherwise, if any specialist voted warn, the decision is warn. Otherwise pass.';
    case 'any_blocking_member':
    default:
      return 'Any blocking member: if any specialist voted block, the decision is block. Otherwise, if any specialist voted warn, the decision is warn. Otherwise pass.';
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
 */
export const CouncilResultManifestSchema = z.object({
  specialists: z.array(CouncilSpecialistResultSchema).max(8),
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
 * Extracts and validates the combined council manifest from the orchestrator's final
 * message.
 *
 * The marker may appear ANYWHERE in the message and the LAST occurrence wins — real
 * models often add a trailing sentence after the marker, and that must not cause a
 * false miss. The payload is captured up to the closing `-->` (which valid JSON never
 * contains), so nested JSON in `findings` is tolerated. Size-capped; schema is strict
 * only where it must be (each specialist's `vote`).
 */
export function parseCouncilResultManifest(
  text: string | null | undefined
): CouncilManifestCapture {
  if (!text) return { status: 'missing' };

  const marker = new RegExp(`<!--\\s*${COUNCIL_RESULT_MARKER_TAG}\\s*([\\s\\S]*?)\\s*-->`, 'g');
  const matches = [...text.matchAll(marker)];
  if (matches.length === 0) return { status: 'missing' };

  const payload = matches[matches.length - 1][1].trim();
  if (new TextEncoder().encode(payload).length > COUNCIL_RESULT_MAX_BYTES) {
    return { status: 'invalid' };
  }

  try {
    const parsed: unknown = JSON.parse(payload);
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

/**
 * The votes to feed `computeCouncilDecision`, reconciled against the specialists we
 * ASKED to run. Any configured specialist absent from the manifest (the orchestrator
 * dropped it) contributes `abstain` — so a dropped specialist can never silently let
 * the council pass. Manifest entries for unknown specialists are ignored.
 */
export function reconcileCouncilVotes(
  configuredSpecialistIds: readonly string[],
  manifest: CouncilResultManifest
): SpecialistVote[] {
  const reported = new Map(manifest.specialists.map(s => [s.specialistId, s.vote]));
  return configuredSpecialistIds.map(specialistId => ({
    specialistId,
    vote: reported.get(specialistId) ?? 'abstain',
  }));
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

export const GovernanceSchema = z.object({
  members: z.array(GovernanceMemberSchema).max(8),
  decision: CouncilVoteSchema,
});
export type Governance = z.infer<typeof GovernanceSchema>;
export type GovernanceMember = z.infer<typeof GovernanceMemberSchema>;

/**
 * Extracts and validates the display-only governance marker from an assistant message.
 * Returns null when absent or malformed. This drives display only; never derive the
 * merge decision from it.
 */
export function parseGovernanceMarker(text: string | null | undefined): Governance | null {
  if (!text) return null;
  const marker = new RegExp(`<!--\\s*${GOVERNANCE_MARKER_TAG}\\s*(\\{[\\s\\S]*?\\})\\s*-->`);
  const match = text.match(marker);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
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
 * Whether there is a renderable council definition (enabled with at least one enabled
 * specialist). This only guards prompt rendering — whether a run IS a council run is
 * recorded per-run via `review_type`, not inferred here.
 */
export function isCouncilActive(council: CodeReviewCouncilConfig | undefined | null): boolean {
  return !!council && council.enabled && enabledSpecialists(council).length > 0;
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

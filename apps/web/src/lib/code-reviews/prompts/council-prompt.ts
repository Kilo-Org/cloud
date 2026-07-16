import 'server-only';

import type { CouncilAggregationStrategy, CouncilSpecialist } from '@kilocode/db/schema-types';
import type { RuntimeAgentInput } from '@kilocode/worker-utils/cloud-agent-next-client';
import {
  COUNCIL_RESULT_MARKER_TAG,
  describeAggregationStrategy,
  formatAggregationStrategy,
} from '@kilocode/worker-utils/code-review-council';

/**
 * Council execution prompts (single-session, multi-model).
 *
 * The primary agent acts as the COORDINATOR: it delegates to one sub-agent per specialist
 * (each pinned to its own model via `runtimeAgents`), collects their structured results,
 * and emits ONE combined `kilo-code-review-council:v1` manifest. Our code — never the
 * model — computes the governance decision from that manifest.
 *
 * NOTE: these prompts are a first cut and are expected to be tuned against real inference
 * in local development. The machine-readable manifest contract below is the load-bearing
 * part and must stay in sync with `CouncilResultManifestSchema` / `parseCouncilResultManifest`.
 */

/** Per-specialist sub-agent prompt: review only through this specialist's lens. */
export function buildSpecialistAgentPrompt(specialist: CouncilSpecialist): string {
  const extra = specialist.instructions?.trim();
  return [
    `You are the "${specialist.name}" code-review specialist.`,
    `Review the pull request changes ONLY through this lens: ${specialist.lens}`,
    extra ? `Additional instructions: ${extra}` : null,
    '',
    'Scope and limits (IMPORTANT — stay efficient and converge quickly):',
    '- READ-ONLY, static analysis only. Do NOT run, execute, build, or test anything, and do',
    '  NOT attempt shell commands that execute code — the sandbox blocks it and retrying only',
    '  wastes the run. Base your review on reading the diff and the changed files.',
    '- Review ONLY the changed files plus the minimal surrounding context needed to judge',
    '  them. Do NOT explore the wider repository or open unrelated files.',
    '- Be decisive and converge: a handful of targeted file reads is enough. Do NOT loop or',
    '  re-analyze — once you have reviewed the changes through your lens, report and STOP.',
    '',
    'Report back to the coordinator with a single JSON object (no prose) of the form:',
    '{"model":"<the exact model slug you are running as>","vote":"pass|warn|block|abstain","highestSeverity":"<label or null>","findings":[{"path":"...","line":<number|null>,"severity":"<label>","rationale":"..."}]}',
    '',
    'Set "model" to the concrete model you are actually running as (not an "auto" alias).',
    'If you cannot determine it, omit the "model" field entirely.',
    '',
    'Voting guidance: "block" for issues that should stop merge, "warn" for non-blocking',
    'concerns, "pass" if nothing in your lens is wrong, "abstain" only if your lens does',
    'not apply to these changes. Report findings only within your lens.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Coordinator instructions appended to the standard review context. The base prompt
 * supplies repo/PR/diff context; this overrides the acting role to "coordinator" and
 * defines the exact manifest to emit.
 */
export function buildCouncilOrchestratorPrompt(params: {
  basePrompt: string;
  specialists: CouncilSpecialist[];
  aggregationStrategy: CouncilAggregationStrategy;
}): string {
  const { basePrompt, specialists, aggregationStrategy } = params;
  const roster = specialists
    .map(s => `- subagent_type "${s.id}" — ${s.name}: ${s.lens}`)
    .join('\n');
  const specialistNames = specialists.map(s => s.name).join(', ');

  const coordination = [
    '# COUNCIL MODE',
    '',
    'You are the COORDINATOR of a review council. Do NOT review the code yourself.',
    'Delegate to each specialist sub-agent below using the task tool, passing the same',
    'pull request context. Run every specialist and collect its JSON result.',
    '',
    'Specialists:',
    roster,
    '',
    `Governance (for context only — our system computes the final decision): ${describeAggregationStrategy(aggregationStrategy)}`,
    '',
    // A council coordinator is mostly quiet (it delegates and waits), so the live session log
    // looks empty and the run appears stuck. Narrate progress so the operator sees it working.
    'Progress updates — print each of the following as a plain-text status line on its own',
    'line, at the moment you reach it, so the run shows live progress in the session log:',
    `- At the very start, before delegating: "Starting council review with ${specialists.length} specialists (${specialistNames}) using ${formatAggregationStrategy(aggregationStrategy)} governance."`,
    '- Immediately before you start each specialist, name it: "Starting <name> review..."',
    '- Once every specialist has reported back: "All specialists complete. Aggregating results..."',
    '- When you are finished (right before the manifest below): "Council review complete."',
    '',
    '# PUBLISHING THE REVIEW',
    '',
    'The specialists run read-only and report ONLY to you, so YOU publish the review. After',
    'every specialist has reported:',
    "- Treat the specialists' combined findings as the review result and follow the",
    '  publication instructions in the review context below EXACTLY as a standard review does',
    '  (in provider mode: post the inline comments AND the summary to the PR; in kilo mode:',
    '  return them). Merge duplicate findings that land on the same file and line.',
    '- Keep the summary body EXACTLY as the base instructions require: the required leading',
    '  marker (e.g. `<!-- kilo-review -->`) and the standard summary heading come FIRST,',
    '  unchanged — do not put anything before them. Immediately AFTER that standard heading,',
    '  insert a "## Council review" section: a markdown table with one row per specialist,',
    '  columns `Specialist | Model | Vote | Findings`. Render each vote with these icons:',
    '  ✅ Pass, ⚠️ Warn, ⛔ Block, ➖ Abstain.',
    '- The summary must NOT assert a merge verdict of its own — this includes any',
    '  "Recommendation" field the base format asks for (e.g. "Merge" / "Address before merge").',
    '  Wherever the base format wants a recommendation or merge/no-merge statement, write the',
    '  neutral placeholder `Recommendation: determined by council governance (computed by Kilo)`',
    '  instead. The council pass/warn/block decision is code-owned and can differ from what the',
    '  votes alone suggest (our coverage checks fail closed), so you must not recommend',
    '  merging or blocking anywhere.',
    '',
    'When every specialist has reported, emit EXACTLY ONE machine-readable manifest on its',
    'own line in your final message, verbatim on a line by itself. It does NOT need to be',
    'the very last line — if any other trailing markers are required, they may follow it:',
    '',
    `<!-- ${COUNCIL_RESULT_MARKER_TAG} {"specialists":[{"specialistId":"<id>","model":"<model the specialist reported, or omit>","vote":"pass|warn|block|abstain","highestSeverity":"<label or null>","findings":[{"path":"<path>","line":<number|null>,"severity":"<label>","rationale":"<text>"}]}]} -->`,
    '',
    'Include one entry per specialist, using the subagent_type as its specialistId, and',
    "pass through each specialist's findings AND reported model verbatim. Omit the model",
    'field for a specialist that did not report one. Do NOT compute or render an overall',
    'pass/warn/block DECISION anywhere — not in the manifest and not in the PR summary. Our',
    'system computes the authoritative decision from these votes (with coverage checks) and',
    'surfaces it; a model-authored decision could contradict it.',
    '',
    '---',
    '',
    'Shared pull request context for the specialists:',
    '',
  ].join('\n');

  return `${coordination}${basePrompt}`;
}

/**
 * Maps enabled council specialists to cloud-agent-next `runtimeAgents` — one subagent per
 * specialist, each pinned to its own model/effort (falling back to the review default).
 * `model` is always resolved so a per-specialist `variant` always has a model (required
 * by cloud-agent-next's schema).
 *
 * A specialist only inherits the review's default `variant` when it also inherits the
 * default MODEL. Variants (thinking-effort levels) are model-specific, so a specialist
 * running on its OWN model must not borrow the base model's effort — that pairing can be
 * invalid and fail (or run wrong) at session preparation. Such a specialist gets no
 * variant unless it explicitly set its own.
 */
export function buildCouncilRuntimeAgents(params: {
  specialists: CouncilSpecialist[];
  defaultModel: string;
  defaultVariant?: string;
}): RuntimeAgentInput[] {
  const { specialists, defaultModel, defaultVariant } = params;
  return specialists.map(specialist => {
    const usesDefaultModel = !specialist.model_slug;
    const variant = specialist.thinking_effort ?? (usesDefaultModel ? defaultVariant : undefined);
    return {
      slug: specialist.id,
      name: specialist.name,
      config: {
        mode: 'subagent',
        model: specialist.model_slug ?? defaultModel,
        ...(variant ? { variant } : {}),
        prompt: buildSpecialistAgentPrompt(specialist),
        description: specialist.lens,
      },
    };
  });
}

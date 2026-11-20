import { PROBE_CASES } from './datasets/probe-cases';
import { PWD_BASE_CASE_ID } from './measurement-revision';

/** One registry pair the activation measures; the variant is in D1 storage form. */
export type ProbeActivationPair = { model: string; variant: string };

export const PROBE_ACTIVATION_ROUTER = 'efficient';
export const PROBE_ACTIVATION_ENGINE_IDENTITY = 'efficient:v1:6649fed2';
export const PROBE_ACTIVATION_REPETITIONS = 3;
export const PROBE_ACTIVATION_REQUESTED_AT = '2026-11-20T00:00:00.000Z';

/**
 * The cases a revision-3 run of a pair already measured re-runs: the probe cuts and the one
 * decider case whose grading changed, mirrored from `minimumCaseRevisions`.
 */
export const PROBE_ACTIVATION_CASE_IDS: readonly string[] = [
  ...PROBE_CASES.map(benchCase => benchCase.id),
  PWD_BASE_CASE_ID,
];

/**
 * Ready pairs queued in `profile_remeasures` by migration `0035_probe_activation`: a run
 * for one of them reuses every other result and measures only {@link
 * PROBE_ACTIVATION_CASE_IDS} per repetition.
 */
export const PROBE_ACTIVATION_REMEASURE_PAIRS: readonly ProbeActivationPair[] = [
  { model: 'anthropic/claude-haiku-5.5', variant: 'high' },
  { model: 'anthropic/claude-haiku-5.5', variant: 'low' },
  { model: 'anthropic/claude-haiku-5.5', variant: 'max' },
  { model: 'anthropic/claude-haiku-5.5', variant: 'medium' },
  { model: 'anthropic/claude-haiku-5.5', variant: 'none' },
  { model: 'anthropic/claude-haiku-5.5', variant: 'xhigh' },
  { model: 'deepseek/deepseek-v4.1-flash-1017', variant: 'high' },
  { model: 'deepseek/deepseek-v4.1-flash-1017', variant: 'low' },
  { model: 'deepseek/deepseek-v4.1-flash-1017', variant: 'max' },
  { model: 'deepseek/deepseek-v4.1-flash-1017', variant: 'none' },
  { model: 'inclusionai/ling-3.1-flash', variant: 'thinking' },
  { model: 'openai/gpt-6-luna', variant: 'high' },
  { model: 'openai/gpt-6-luna', variant: 'low' },
  { model: 'openai/gpt-6-luna', variant: 'max' },
  { model: 'openai/gpt-6-luna', variant: 'medium' },
  { model: 'openai/gpt-6-luna', variant: 'none' },
  { model: 'qwen/qwen3.8-flash', variant: 'instant' },
  { model: 'qwen/qwen3.8-flash', variant: 'thinking' },
  { model: 'qwen/qwen3.8-max-0902', variant: 'low' },
  { model: 'stepfun/step-5-preview', variant: 'high' },
  { model: 'stepfun/step-5-preview', variant: 'medium' },
  { model: 'xiaomi/mimo-v2.6-pro', variant: 'instant' },
  { model: 'z-ai/glm-5.3-flash', variant: 'high' },
];

/**
 * Failed rep-3 Ember pairs the same migration moves back to `pending` with the per-row
 * Re-admit: a full revision-3 run measures every case it lacks, the probes included.
 */
export const PROBE_ACTIVATION_READMIT_PAIRS: readonly ProbeActivationPair[] = [
  { model: 'meta/muse-ember', variant: 'high' },
  { model: 'meta/muse-ember', variant: 'low' },
  { model: 'meta/muse-ember', variant: 'max' },
  { model: 'meta/muse-ember', variant: 'medium' },
  { model: 'meta/muse-ember', variant: 'minimal' },
  { model: 'meta/muse-ember', variant: 'xhigh' },
];

/** Every pair the activation measures: the remeasure queue and the re-admitted rows. */
export const PROBE_ACTIVATION_PAIRS: readonly ProbeActivationPair[] = [
  ...PROBE_ACTIVATION_REMEASURE_PAIRS,
  ...PROBE_ACTIVATION_READMIT_PAIRS,
];

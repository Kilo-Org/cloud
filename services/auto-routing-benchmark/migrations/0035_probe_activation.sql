-- Measurement revision 3 activation: the staged one-shot activation queue.
--
-- `ACTIVE_MEASUREMENT_REVISION` is 3 in the same deploy, so from the next drain every
-- efficient run measures the probe cuts. This migration decides which pairs that happens
-- to, and it is the whole bound: 30 pairs (24 queued re-measures and 6 Ember re-admits), nothing else.
--
-- The rows are staged in `probe_activations` instead of being written straight into
-- `profile_remeasures` and `benchmark_profiles` because a migration applies while the
-- previous image is still serving. That worker claims `profile_remeasures` rows and
-- `pending` profiles directly (`src/run.ts` drainQueue -> startRun ->
-- markProfilesRunningForRun), so a queue row or a re-admitted `pending` row would be
-- measured under revision 2 during the drain-to-deploy window: the queued pairs would run
-- nothing they lack and lose their queue row, and the six re-admitted Ember rows would be
-- measured without the probes and settle ineligible on the agentic routes. The old worker
-- never reads `probe_activations`; the drain of the deploy that raises the revision
-- consumes it once (`applyProbeActivations`, `src/probe-activation.ts`):
--
-- 1. `remeasure`: the 24 pairs that are `ready` at `efficient:v1:6649fed2`, repetitions 3 and
--    queued in `profile_remeasures`, exactly as the `remeasure-prompt-transport` `request`
--    action queues them. The profile stays ready on its current run and keeps serving; the
--    drain claims the row, copies every result that is still reusable, and measures the 21
--    probe cuts plus `supp-agent-term-pwd-base` per repetition. A pair that already holds a
--    revision-3 result for every one of those cases is skipped when the row is applied, so
--    it is never re-measured. `meta/muse-spark-1.2-contributor` `high` is the 24th: a user-owned
--    rep-3 pair whose provenance run has no probe rows, so it drains on the user queue.
--
-- 2. `readmit`: `meta/muse-ember` has no ready rep-3 profile: its 2026-11-11 run lost a
--    lane and all six variants were left `failed` (class `unknown`, retryable). It is the
--    model this grading exists for, so the six rows are re-admitted the way the per-row
--    Re-admit does it (`src/profile-refresh.ts`): back to `pending`, failure history
--    cleared, retry budgets reset, `invalidated_at` stamped, so the next platform drain
--    measures a full revision-3 run for them and does not reuse the failed run's rows.
--
-- The pair list is mirrored in `src/probe-activation.ts`, and
-- `src/probe-activation-sql.test.ts` fails when the two drift apart.

CREATE TABLE `probe_activations` (
	`router` text NOT NULL,
	`action` text NOT NULL,
	`model` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`engine_identity` text NOT NULL,
	`repetitions` integer NOT NULL,
	`requested_at` text NOT NULL,
	PRIMARY KEY(`router`, `action`, `model`, `variant`, `engine_identity`, `repetitions`)
);
--> statement-breakpoint
INSERT INTO `probe_activations`
  (`router`, `action`, `model`, `variant`, `engine_identity`, `repetitions`, `requested_at`)
VALUES
  ('efficient', 'remeasure', 'anthropic/claude-haiku-5.5', 'high', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'anthropic/claude-haiku-5.5', 'low', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'anthropic/claude-haiku-5.5', 'max', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'anthropic/claude-haiku-5.5', 'medium', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'anthropic/claude-haiku-5.5', 'none', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'anthropic/claude-haiku-5.5', 'xhigh', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'deepseek/deepseek-v4.1-flash-1017', 'high', 'efficient:v1:6649fed2',
    3, '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'deepseek/deepseek-v4.1-flash-1017', 'low', 'efficient:v1:6649fed2',
    3, '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'deepseek/deepseek-v4.1-flash-1017', 'max', 'efficient:v1:6649fed2',
    3, '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'deepseek/deepseek-v4.1-flash-1017', 'none', 'efficient:v1:6649fed2',
    3, '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'inclusionai/ling-3.1-flash', 'thinking', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'meta/muse-spark-1.2-contributor', 'high', 'efficient:v1:6649fed2',
    3, '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'openai/gpt-6-luna', 'high', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'openai/gpt-6-luna', 'low', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'openai/gpt-6-luna', 'max', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'openai/gpt-6-luna', 'medium', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'openai/gpt-6-luna', 'none', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'qwen/qwen3.8-flash', 'instant', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'qwen/qwen3.8-flash', 'thinking', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'qwen/qwen3.8-max-0902', 'low', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'stepfun/step-5-preview', 'high', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'stepfun/step-5-preview', 'medium', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'xiaomi/mimo-v2.6-pro', 'instant', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'remeasure', 'z-ai/glm-5.3-flash', 'high', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'readmit', 'meta/muse-ember', 'high', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'readmit', 'meta/muse-ember', 'low', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'readmit', 'meta/muse-ember', 'max', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'readmit', 'meta/muse-ember', 'medium', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'readmit', 'meta/muse-ember', 'minimal', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z'),
  ('efficient', 'readmit', 'meta/muse-ember', 'xhigh', 'efficient:v1:6649fed2', 3,
    '2026-11-20T00:00:00.000Z')
ON CONFLICT DO NOTHING;

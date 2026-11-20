-- Measurement revision 3 activation (data only; no schema change).
--
-- `ACTIVE_MEASUREMENT_REVISION` is 3 in the same deploy, so from the next drain every
-- efficient run measures the probe cuts. This migration decides which pairs that happens
-- to, and it is the whole bound: 29 agentic-route pairs, nothing else.
--
-- 1. The 23 pairs that are `ready` at `efficient:v1:6649fed2`, repetitions 3 are queued in
--    `profile_remeasures`, exactly as the `remeasure-prompt-transport` `request` action
--    queues them. The profile stays ready on its current run and keeps serving; the drain
--    claims the row, copies every result that is still reusable, and measures the 21 probe
--    cuts plus `supp-agent-term-pwd-base` per repetition. A pair that already holds a
--    revision-3 result for every one of those cases is not queued, so re-running this
--    statement never re-measures a pair.
--
-- 2. `meta/muse-ember` has no ready rep-3 profile: its 2026-11-11 run lost a lane and all
--    six variants were left `failed` (class `unknown`, retryable). It is the model this
--    grading exists for, so the six rows are re-admitted the way the per-row Re-admit does
--    it (`src/profile-refresh.ts`): back to `pending`, failure history cleared, retry
--    budgets reset. The next platform drain measures a full revision-3 run for them,
--    reusing every compatible stored result.
--
-- Both statements are idempotent: the queue insert conflicts on its primary key and skips
-- pairs already measured at revision 3; the re-admit only touches rows still `failed`.
--
-- The pair and case lists are mirrored in `src/probe-activation.ts`, and
-- `src/probe-activation-sql.test.ts` fails when the two drift apart.

WITH `remeasure`(`model`, `variant`) AS (
  VALUES
    ('anthropic/claude-haiku-5.5', 'high'),
    ('anthropic/claude-haiku-5.5', 'low'),
    ('anthropic/claude-haiku-5.5', 'max'),
    ('anthropic/claude-haiku-5.5', 'medium'),
    ('anthropic/claude-haiku-5.5', 'none'),
    ('anthropic/claude-haiku-5.5', 'xhigh'),
    ('deepseek/deepseek-v4.1-flash-1017', 'high'),
    ('deepseek/deepseek-v4.1-flash-1017', 'low'),
    ('deepseek/deepseek-v4.1-flash-1017', 'max'),
    ('deepseek/deepseek-v4.1-flash-1017', 'none'),
    ('inclusionai/ling-3.1-flash', 'thinking'),
    ('openai/gpt-6-luna', 'high'),
    ('openai/gpt-6-luna', 'low'),
    ('openai/gpt-6-luna', 'max'),
    ('openai/gpt-6-luna', 'medium'),
    ('openai/gpt-6-luna', 'none'),
    ('qwen/qwen3.8-flash', 'instant'),
    ('qwen/qwen3.8-flash', 'thinking'),
    ('qwen/qwen3.8-max-0902', 'low'),
    ('stepfun/step-5-preview', 'high'),
    ('stepfun/step-5-preview', 'medium'),
    ('xiaomi/mimo-v2.6-pro', 'instant'),
    ('z-ai/glm-5.3-flash', 'high')
),
`probe_cases`(`case_id`) AS (
  VALUES
    ('probe-cont-agent-tool-invoice-rollup-step-1'),
    ('probe-cont-agent-tool-invoice-rollup-step-2'),
    ('probe-cont-agent-tool-invoice-rollup-step-3'),
    ('probe-cont-agent-tool-access-latency-step-1'),
    ('probe-cont-agent-tool-access-latency-step-2'),
    ('probe-cont-agent-tool-i18n-sync-step-1'),
    ('probe-cont-agent-tool-i18n-sync-step-2'),
    ('probe-cont-agent-tool-i18n-sync-step-3'),
    ('probe-cont-agent-term-env-rollout-step-1'),
    ('probe-cont-agent-term-env-rollout-step-2'),
    ('probe-cont-agent-term-log-split-step-1'),
    ('probe-cont-agent-term-log-split-step-2'),
    ('probe-cont-agent-term-migration-renumber-step-1'),
    ('probe-cont-agent-term-migration-renumber-step-2'),
    ('probe-cont-agent-term-migration-renumber-step-3'),
    ('probe-cont-agent-multi-pricing-fix-step-1'),
    ('probe-cont-agent-multi-pricing-fix-step-2'),
    ('probe-cont-agent-multi-user-migration-step-1'),
    ('probe-cont-agent-multi-user-migration-step-2'),
    ('probe-cont-agent-multi-etl-dedupe-step-1'),
    ('probe-cont-agent-multi-etl-dedupe-step-2'),
    ('supp-agent-term-pwd-base')
)
INSERT INTO `profile_remeasures`
  (`router`, `model`, `variant`, `engine_identity`, `repetitions`, `run_id`, `requested_at`,
    `claimed_at`)
SELECT
  'efficient', `remeasure`.`model`, `remeasure`.`variant`, 'efficient:v1:6649fed2', 3, NULL,
  '2026-11-20T00:00:00.000Z', NULL
FROM `remeasure`
JOIN `benchmark_profiles` AS `p`
  ON `p`.`router` = 'efficient'
  AND `p`.`model` = `remeasure`.`model`
  AND `p`.`variant` = `remeasure`.`variant`
  AND `p`.`engine_identity` = 'efficient:v1:6649fed2'
  AND `p`.`repetitions` = 3
  AND `p`.`status` = 'ready'
  AND `p`.`run_id` IS NOT NULL
WHERE EXISTS (
  SELECT 1 FROM `probe_cases` AS `probe`
  WHERE NOT EXISTS (
    SELECT 1 FROM `case_results` AS `measured`
    WHERE `measured`.`run_id` = `p`.`run_id`
      AND `measured`.`model` = `p`.`model`
      AND `measured`.`variant` = `p`.`variant`
      AND `measured`.`case_id` = `probe`.`case_id`
      AND `measured`.`prompt_revision` >= 3
  )
)
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE `benchmark_profiles` SET
  `status` = 'pending',
  `failure_reason` = NULL,
  `failure_class` = NULL,
  `failure_attempts` = 0,
  `model_failure_attempts` = 0,
  `first_failed_at` = NULL,
  `retry_after` = NULL,
  `run_id` = NULL,
  `completed_at` = NULL,
  `requested_at` = '2026-11-20T00:00:00.000Z',
  `updated_at` = '2026-11-20T00:00:00.000Z',
  `invalidated_at` = '2026-11-20T00:00:00.000Z'
WHERE `router` = 'efficient'
  AND `model` = 'meta/muse-ember'
  AND `variant` IN ('high', 'low', 'max', 'medium', 'minimal', 'xhigh')
  AND `engine_identity` = 'efficient:v1:6649fed2'
  AND `repetitions` = 3
  AND `status` = 'failed'
  AND `failure_class` = 'unknown'
  AND NOT EXISTS (
    SELECT 1 FROM `scheduler_chunks` AS `chunk`
    WHERE `chunk`.`model` = `benchmark_profiles`.`model`
      AND `chunk`.`variant` = `benchmark_profiles`.`variant`
      AND `chunk`.`status` IN ('queued', 'active')
  );

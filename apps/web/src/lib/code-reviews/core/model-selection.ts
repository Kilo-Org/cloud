/**
 * Per-repository model selection.
 *
 * A Code Reviewer config carries a global `model_slug` / `thinking_effort` plus an
 * optional list of per-repository overrides (`repository_model_overrides`). This
 * helper resolves the *effective* model for a single review: an override applies
 * only when its `repo_full_name` exactly matches the review's repository; otherwise
 * the global model is used.
 *
 * Matching is on `repo_full_name` because that is the only repo identifier persisted
 * on the review row across every platform (numeric IDs are not on the row for GitHub
 * or Bitbucket). See `RepositoryModelOverrideSchema`.
 */

import type { CodeReviewAgentConfig } from '@kilocode/db/schema-types';

export type EffectiveModelSelection = {
  modelSlug: string;
  thinkingEffort: string | null;
  source: 'repository_override' | 'global';
};

/**
 * Resolve the effective model for a review's repository.
 *
 * @param config       The Code Reviewer agent config (global model + overrides).
 * @param repoFullName The review row's `repo_full_name` (e.g. "owner/repo"). Null/
 *                     empty falls back to the global model.
 * @param fallbackModel Model to use when the config has no global `model_slug`
 *                     (mirrors the existing `config.model_slug || DEFAULT_...` guard).
 */
export function resolveEffectiveModel(
  config: Pick<
    CodeReviewAgentConfig,
    'model_slug' | 'thinking_effort' | 'repository_model_overrides'
  >,
  repoFullName: string | null | undefined,
  fallbackModel: string
): EffectiveModelSelection {
  const globalSelection: EffectiveModelSelection = {
    modelSlug: config.model_slug || fallbackModel,
    thinkingEffort: config.thinking_effort ?? null,
    source: 'global',
  };

  if (!repoFullName) return globalSelection;

  const override = config.repository_model_overrides?.find(
    entry => entry.repo_full_name === repoFullName
  );

  // An override with a blank model_slug is treated as "no override" so a malformed
  // entry can never blank out the model — fall back to the global selection.
  if (!override || !override.model_slug) return globalSelection;

  return {
    modelSlug: override.model_slug,
    thinkingEffort: override.thinking_effort ?? null,
    source: 'repository_override',
  };
}

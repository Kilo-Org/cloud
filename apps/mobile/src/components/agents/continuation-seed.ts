import { normalizeAgentMode } from '@/components/agents/mode-normalize';
import {
  buildContinuePrefillParams,
  type NewSessionPrefill,
  resolvePrefillModel,
  resolvePrefillRepo,
} from '@/components/agents/new-session-prefill';

export type ContinuationResolution =
  | {
      kind: 'cloud-agent';
      repo: string;
      model: string;
      variant: string;
      githubIntegrationId?: string;
    }
  | { kind: 'unmatched-repository' }
  | { kind: 'unresolved-model' };

/**
 * Resolve a continuation to a single outcome with the failure reason kept.
 * An unmatched repository (missing `gitUrl`, non-GitHub URL, or no matching
 * repo) is distinct from a matched repository whose model is still loading
 * or missing, so callers can map each to the right guidance.
 */
export function resolveContinuationResolution(args: {
  gitUrl: string | null | undefined;
  mode: string;
  model: string;
  variant: string;
  repositories: { fullName: string; platformIntegrationId?: string }[];
  models: { id: string; variants: string[] }[];
}): ContinuationResolution {
  const { gitUrl, mode, model, variant, repositories, models } = args;

  const prefillParams = buildContinuePrefillParams({
    gitUrl,
    mode,
    model,
    variant,
  });
  const prefill: NewSessionPrefill = {
    mode: normalizeAgentMode(mode),
    ...(prefillParams.repo ? { repo: prefillParams.repo } : {}),
    ...(prefillParams.model ? { model: prefillParams.model } : {}),
    ...(prefillParams.variant ? { variant: prefillParams.variant } : {}),
  };

  const repo = resolvePrefillRepo(repositories, prefill);
  if (repo === null) {
    return { kind: 'unmatched-repository' };
  }

  const resolvedModel = resolvePrefillModel(models, prefill);
  if (resolvedModel === null) {
    return { kind: 'unresolved-model' };
  }

  const matchingRepositories = repositories.filter(candidate => candidate.fullName === repo);
  if (matchingRepositories.length !== 1) {
    return { kind: 'unmatched-repository' };
  }
  const repository = matchingRepositories[0];
  return {
    kind: 'cloud-agent',
    repo,
    model: resolvedModel.model,
    variant: resolvedModel.variant,
    ...(repository?.platformIntegrationId
      ? { githubIntegrationId: repository.platformIntegrationId }
      : {}),
  };
}

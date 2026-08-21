import { normalizeAgentMode } from '@/components/agents/mode-normalize';
import {
  buildContinuePrefillParams,
  type NewSessionPrefill,
  resolvePrefillModel,
  resolvePrefillRepo,
} from '@/components/agents/new-session-prefill';
import { type InstancePickerInstance } from '@/lib/picker-bridge';

export type ContinuationDestination =
  | { kind: 'cloud-agent'; repo: string; model: string; variant: string }
  | { kind: 'remote'; instance: InstancePickerInstance };

export function resolveContinuationDestinations(args: {
  gitUrl: string | null | undefined;
  mode: string;
  model: string;
  variant: string;
  repositories: { fullName: string }[];
  models: { id: string; variants: string[] }[];
}): ContinuationDestination[] {
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

  const result: ContinuationDestination[] = [];

  // Cloud destination when both repo and model resolve.
  const repo = resolvePrefillRepo(repositories, prefill);
  const resolvedModel = resolvePrefillModel(models, prefill);
  if (repo !== null && resolvedModel !== null) {
    result.push({
      kind: 'cloud-agent',
      repo,
      model: resolvedModel.model,
      variant: resolvedModel.variant,
    });
  }

  return result;
}

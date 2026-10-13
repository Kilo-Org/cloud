import { ModelError } from '@kilocode/harness-sdk';

import { LocalModelError, type LocalModelProblem } from './local-model-error';

const UNAVAILABLE_REASONS = {
  unsupported_os: true,
  device_not_eligible: true,
  apple_intelligence_disabled: true,
  model_not_ready: true,
  model_unavailable: true,
  model_download_required: true,
  model_downloading: true,
  aicore_incompatible: true,
  system_update_required: true,
  battery_quota_exceeded: true,
} satisfies Readonly<Record<string, true>>;

export function nativeModelFailure(reason: string | undefined, started: boolean): ModelError {
  let problem: LocalModelProblem = 'failed';
  if (reason === 'busy') {
    problem = 'busy';
  } else if (reason === 'background_use_blocked') {
    problem = 'background';
  } else if (reason !== undefined && Object.hasOwn(UNAVAILABLE_REASONS, reason)) {
    problem = 'unavailable';
  }
  return new ModelError({
    reason: started ? 'stream' : 'unsupported',
    cause: new LocalModelError(problem),
  });
}

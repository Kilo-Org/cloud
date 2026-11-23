import { ModelError } from '@kilocode/harness-sdk';

import { LocalModelError, type LocalModelProblem } from './local-model-error';

/**
 * The codes that pick a specific copy class instead of the generic failure the
 * parser falls back to. `unsupported_os` and `model_unavailable` stay on the
 * neutral class: the iOS and Android sentences differ, and this path has no
 * provider to ask. `models_unreadable` is the failed check: the saved list
 * could not be read, so the generic empty-library copy would misdescribe it.
 */
const REASON_PROBLEMS = {
  model_download_required: 'downloadRequired',
  model_downloading: 'downloading',
  model_not_ready: 'preparing',
  system_update_required: 'updateRequired',
  aicore_incompatible: 'updateRequired',
  apple_intelligence_disabled: 'settingsOff',
  device_not_eligible: 'ineligible',
  battery_quota_exceeded: 'quotaExhausted',
  check_failed: 'checkFailed',
  models_unreadable: 'checkFailed',
  unsupported_os: 'unavailable',
  model_unavailable: 'unavailable',
  busy: 'busy',
  background_use_blocked: 'background',
} as const satisfies Record<string, LocalModelProblem>;

/** An undocumented code is a failure: copy that explains nothing is worse than the generic one. */
function problemOf(reason: string | undefined): LocalModelProblem {
  if (reason === undefined || !Object.hasOwn(REASON_PROBLEMS, reason)) {
    return 'failed';
  }
  return REASON_PROBLEMS[reason as keyof typeof REASON_PROBLEMS];
}

export function nativeModelFailure(reason: string | undefined, started: boolean): ModelError {
  return new ModelError({
    reason: started ? 'stream' : 'unsupported',
    cause: new LocalModelError(problemOf(reason)),
  });
}

import type { StartupFailureCode } from '../sandbox-control/startup-failure.js';

const details: Record<StartupFailureCode, string> = {
  artifact_unavailable: 'The runtime download is temporarily unavailable. Retry the build.',
  artifact_unauthorized: 'Runtime download authorization failed. Retry the build.',
  base_incompatible:
    'The runtime image is incompatible. Contact Kilo to update the AWS connection before retrying.',
  artifact_invalid: 'The runtime download failed verification. Retry the build.',
  install_interrupted: 'Runtime installation was interrupted. Retry the build.',
  deadline_exceeded: 'Runtime startup exceeded its deadline. Retry the build.',
  cli_probe_failed: 'The installed runtime failed its startup check. Retry the build.',
  supervisor_missing: 'The downloaded builder is incomplete. Retry the build.',
  environment_restore_unavailable:
    'The prepared environment is temporarily unavailable. Retry the build.',
  environment_restore_failed:
    'The prepared environment could not be restored. Rebuild the environment.',
};
export function buildStartupFailureDetail(code: StartupFailureCode): string {
  return details[code];
}

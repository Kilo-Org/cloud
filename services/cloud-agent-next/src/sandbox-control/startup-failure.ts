export const STARTUP_FAILURES = {
  artifact_unavailable: { exitCode: 70, reason: null },
  artifact_unauthorized: { exitCode: 71, reason: 'runtime_artifact_unauthorized' },
  base_incompatible: { exitCode: 72, reason: null },
  artifact_invalid: { exitCode: 73, reason: 'runtime_artifact_invalid' },
  install_interrupted: { exitCode: 74, reason: null },
  deadline_exceeded: { exitCode: 75, reason: null },
  cli_probe_failed: { exitCode: 76, reason: 'runtime_cli_probe_failed' },
  supervisor_missing: { exitCode: 77, reason: 'runtime_supervisor_missing' },
} as const;

export type StartupFailureCode = keyof typeof STARTUP_FAILURES;

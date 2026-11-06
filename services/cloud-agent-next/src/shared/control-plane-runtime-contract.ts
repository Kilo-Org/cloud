// HTTP upgrade headers are ignored by older Workers. Adding a hello field would
// break their strict frame schema and disable negotiated secret redaction.
export const WORKTREE_RUNTIME_HEADER = 'x-kilo-worktree-runtime';
export const WORKTREE_RUNTIME_VERSION = '1';

export const WORKSPACE_CONFIGURATION_HEADER = 'x-kilo-workspace-configuration';
export const WORKSPACE_CONFIGURATION_VERSION = '1';

export const KILO_CLI_VERSION_HEADER = 'x-kilo-cli-version';
export const WRAPPER_VERSION_HEADER = 'x-kilo-wrapper-version';

// The Kilo runtime the wrapper actually runs. The Worker records it per run so
// v1 (`kilo`) and v2 (`kilo2`) outcomes can be compared.
export const RUNTIME_HARNESS_HEADER = 'x-kilo-runtime-harness';
export const RUNTIME_HARNESSES = ['kilo', 'kilo2'] as const;
export type RuntimeHarness = (typeof RUNTIME_HARNESSES)[number];

export function parseRuntimeHarness(value: string | null | undefined): RuntimeHarness | undefined {
  return RUNTIME_HARNESSES.find(harness => harness === value);
}

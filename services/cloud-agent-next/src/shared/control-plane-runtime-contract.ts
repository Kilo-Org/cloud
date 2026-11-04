// HTTP upgrade headers are ignored by older Workers. Adding a hello field would
// break their strict frame schema and disable negotiated secret redaction.
export const WORKTREE_RUNTIME_HEADER = 'x-kilo-worktree-runtime';
export const WORKTREE_RUNTIME_VERSION = '1';

export const WORKSPACE_CONFIGURATION_HEADER = 'x-kilo-workspace-configuration';
export const WORKSPACE_CONFIGURATION_VERSION = '1';

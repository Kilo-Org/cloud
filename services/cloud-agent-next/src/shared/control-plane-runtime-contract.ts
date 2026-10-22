// HTTP upgrade headers are ignored by older Workers. Adding a hello field would
// break their strict frame schema and disable negotiated secret redaction.
export const WORKTREE_RUNTIME_HEADER = 'x-kilo-worktree-runtime';
export const WORKTREE_RUNTIME_VERSION = '1';

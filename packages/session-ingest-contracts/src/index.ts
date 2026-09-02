export * from './rpc-contract';
export * from './cloud-agent-session-scope';
export * from './public-worktree-projection';

export const DEFAULT_SESSION_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isDefaultSessionTitle(title: string | null | undefined): boolean {
  return title == null || DEFAULT_SESSION_TITLE_PATTERN.test(title);
}

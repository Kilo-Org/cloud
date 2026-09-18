/**
 * Public-surface-only scenario helpers: nothing here reads Docker, the
 * filesystem, worker logs or `@kilocode/db`, so the deployed profile can use
 * every helper.
 *
 * `worktree-support.ts` and `lifecycle-file-state.ts` re-export
 * `requireWorktreeSessionIdentity`/`readWorktreeOwnership` and
 * `assertScenarioPreconditions` respectively, so their existing callers keep
 * their import site.
 */

import {
  getSessionSnapshot,
  type ApiVersion,
  type DriverConfig,
  type WorktreeSessionResult,
} from './client.js';

export type WorktreeOwnershipRow = {
  sessionId: string;
  userId: string;
  organizationId: string | null;
  parentSessionId: string | null;
  cloudAgentSessionId: string | null;
  cloudAgentSessionScopeId: string | null;
  worktreeId: string | null;
};

export async function readWorktreeOwnership(
  config: DriverConfig,
  cloudAgentSessionIds: string[]
): Promise<WorktreeOwnershipRow[]> {
  const rows: WorktreeOwnershipRow[] = [];
  for (const cloudAgentSessionId of cloudAgentSessionIds) {
    const snapshot = await getSessionSnapshot(config, cloudAgentSessionId);
    if (!snapshot.kiloSessionId) {
      throw new Error(`getSession(${cloudAgentSessionId}) returned no kiloSessionId`);
    }
    rows.push({
      sessionId: snapshot.kiloSessionId,
      userId: snapshot.userId,
      organizationId: snapshot.orgId ?? null,
      parentSessionId: snapshot.parentSessionId ?? null,
      cloudAgentSessionId: snapshot.sessionId,
      cloudAgentSessionScopeId: snapshot.cloudAgentSessionScopeId ?? null,
      worktreeId: snapshot.worktreeId ?? null,
    });
  }
  return rows;
}

export function requireWorktreeSessionIdentity(
  session: WorktreeSessionResult,
  label: string
): void {
  if (!/^workspace_[0-9a-f-]{36}$/i.test(session.cloudAgentSessionId)) {
    throw new Error(`${label} did not receive a control-plane workspace_* identity`);
  }
  if (!/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(session.kiloSessionId)) {
    throw new Error(`${label} did not receive a valid root ses_* identity`);
  }
}

export function assertScenarioPreconditions(
  config: DriverConfig,
  api: ApiVersion | undefined
): void {
  if ((api ?? 'unified') !== 'unified') {
    throw new Error('shared scenarios require the unified API');
  }
  if (config.model.replace(/^kilo\//, '') !== 'fake-deterministic') {
    throw new Error(`shared scenarios require kilo/fake-deterministic, got ${config.model}`);
  }
}

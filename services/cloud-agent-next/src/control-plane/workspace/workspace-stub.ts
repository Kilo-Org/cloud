import { sessionDoName } from '../../session-identity.js';
import type { Env } from '../../types.js';
import type { CloudAgentWorkspaceDO } from './workspace-do.js';

export type WorkspaceStubEnv = Pick<Env, 'CLOUD_AGENT_WORKSPACE'>;
export type WorkspaceStub = DurableObjectStub<CloudAgentWorkspaceDO>;

/** The one place a workspace authority DO is named: `ownerId:workspace_<uuid>`. */
export function getWorkspaceStub(
  env: WorkspaceStubEnv,
  ownerId: string,
  workspaceSessionId: string
): WorkspaceStub {
  return env.CLOUD_AGENT_WORKSPACE.get(
    env.CLOUD_AGENT_WORKSPACE.idFromName(sessionDoName(ownerId, workspaceSessionId))
  );
}

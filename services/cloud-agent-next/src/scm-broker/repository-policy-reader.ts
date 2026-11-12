import { REPOSITORY_ACCESS_PROTOCOL_VERSION } from '@kilocode/worker-utils/workspace-repository-access';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { and, eq, isNotNull } from 'drizzle-orm';
import { cli_sessions_v2, cloud_agent_sessions } from '@kilocode/db/schema';
import type {
  WorkspaceRepositoryPolicyLookup,
  WorkspaceRepositoryScope,
  WorkspaceRepositoryPolicyResult,
} from '@kilocode/worker-utils/workspace-repository-access';
import { getPgDb } from '../db/pg.js';
import { isSafeSandboxId } from '../shared/control-plane-credential.js';
import { withDORetry } from '../utils/do-retry.js';
import type { Env } from '../types.js';

/** No HTTP handler. Only the credential broker's service binding can invoke this reader. */
export class RepositoryPolicyReader extends WorkerEntrypoint<Env> {
  async repositoryAccessProtocolVersion(): Promise<number> {
    return REPOSITORY_ACCESS_PROTOCOL_VERSION;
  }
  async readWorkspaceRepositoryPolicyForScope(
    input: WorkspaceRepositoryScope
  ): Promise<WorkspaceRepositoryPolicyResult> {
    if (!isSafeSandboxId(input.sandboxId)) return null;
    return withDORetry(
      () => this.env.SANDBOX_CONTROL.getByName(input.sandboxId),
      stub => stub.readWorkspaceRepositoryPolicyForScope(input),
      'readWorkspaceRepositoryPolicyForScope'
    );
  }
  async admitWorkspaceRepositoryCapability(
    input: WorkspaceRepositoryScope
  ): Promise<WorkspaceRepositoryPolicyResult> {
    if (!isSafeSandboxId(input.sandboxId)) return null;
    return withDORetry(
      () => this.env.SANDBOX_CONTROL.getByName(input.sandboxId),
      stub => stub.admitWorkspaceRepositoryCapability(input),
      'admitWorkspaceRepositoryCapability'
    );
  }
  async readWorkspaceRepositoryPolicy(
    input: WorkspaceRepositoryPolicyLookup
  ): Promise<WorkspaceRepositoryPolicyResult> {
    if (input.sandboxId) return this.readAt(input.sandboxId, input);
    // Compatibility callers have no logical locator. Read trusted ledger locations, then ask
    // each canonical owner to verify the exact outbound binding. Do not decode or guess IDs.
    if (!input.scopeId) return null;
    const db = getPgDb(this.env);
    const rows = await db
      .selectDistinct({ sandboxId: cloud_agent_sessions.sandbox_id })
      .from(cloud_agent_sessions)
      .innerJoin(
        cli_sessions_v2,
        eq(cli_sessions_v2.cloud_agent_session_id, cloud_agent_sessions.cloud_agent_session_id)
      )
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, input.userId),
          isNotNull(cloud_agent_sessions.sandbox_id),
          ...(input.scopeId
            ? [
                input.scopeId.startsWith('worktree_')
                  ? eq(cli_sessions_v2.cloud_agent_worktree_id, input.scopeId)
                  : eq(cloud_agent_sessions.cloud_agent_session_id, input.scopeId),
              ]
            : [])
        )
      )
      .limit(2);
    for (const row of rows) {
      if (!row.sandboxId) continue;
      const policy = await this.readAt(row.sandboxId, input);
      if (policy) return policy;
    }
    return null;
  }

  private async readAt(
    sandboxId: string,
    input: WorkspaceRepositoryPolicyLookup
  ): Promise<WorkspaceRepositoryPolicyResult> {
    if (!isSafeSandboxId(sandboxId)) return null;
    return withDORetry(
      () => this.env.SANDBOX_CONTROL.getByName(sandboxId),
      stub => stub.readWorkspaceRepositoryPolicy(input),
      'readWorkspaceRepositoryPolicy'
    );
  }
}

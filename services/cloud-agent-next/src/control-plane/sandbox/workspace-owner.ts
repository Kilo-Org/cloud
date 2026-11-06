import { z } from 'zod';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { hashToSandboxId } from '../../sandbox-id.js';
import type { SandboxKind } from '../../sandbox-placement.js';
import { getControlPlaneSessionDirectory, getWorktreeWorkspacePath } from '../../workspace.js';
import type {
  ControlPlaneCredentialSource,
  ControlPlaneRouteSpec,
} from '../../shared/control-plane-protocol.js';

export const WORKSPACE_OWNER_KEY = 'sandbox_workspace_owner:v1';

export const sandboxWorkspaceOwnerSchema = z
  .object({
    kind: z.enum(['workspace', 'standalone']),
    workspaceId: z.string().min(1),
    directory: z.string().min(1),
    userId: z.string().min(1),
    orgId: z.string().optional(),
  })
  .strict();

export type SandboxWorkspaceOwner = z.infer<typeof sandboxWorkspaceOwnerSchema>;

export function workspaceOwnerFromRoute(
  spec: Pick<ControlPlaneRouteSpec, 'sessionId' | 'directory'>,
  source: ControlPlaneCredentialSource,
  historical = false
): SandboxWorkspaceOwner {
  const scopeId = source.scopeId ?? spec.sessionId;
  const workspaceId = source.workspaceId ?? (historical ? scopeId : undefined);
  if (
    workspaceId === undefined ||
    scopeId !== workspaceId ||
    (!cloudAgentWorktreeIdSchema.safeParse(workspaceId).success &&
      (!historical || workspaceId !== spec.sessionId))
  ) {
    throw new Error('Sandbox workspace identity is required');
  }
  return {
    kind: workspaceId === spec.sessionId ? 'standalone' : 'workspace',
    workspaceId,
    directory: spec.directory,
    userId: source.userId,
    orgId: source.orgId,
  };
}

export function sameSandboxWorkspaceOwner(
  owner: SandboxWorkspaceOwner,
  candidate: SandboxWorkspaceOwner
): boolean {
  return (['kind', 'workspaceId', 'directory', 'userId', 'orgId'] as const).every(
    key => owner[key] === candidate[key]
  );
}

export async function recoverHistoricalWorkspaceOwner(input: {
  sandboxId: string;
  userId: string;
  workspaceId: string;
  sandboxKind?: SandboxKind;
  readWorkspace: (workspaceId: `worktree_${string}`) => Promise<{
    workspaceId: string;
    userId: string;
    organizationId: string | null;
  } | null>;
}): Promise<SandboxWorkspaceOwner | undefined> {
  const workspaceId = cloudAgentWorktreeIdSchema.safeParse(input.workspaceId);
  const prefix = input.sandboxId.split('-')[0];
  if (!workspaceId.success || !['sbx', 'ses', 'istd', 'crv'].includes(prefix)) return undefined;
  const sessionId = `workspace_${workspaceId.data.slice('worktree_'.length)}`;
  const expectedSandboxId = await hashToSandboxId(
    prefix === 'sbx' ? `control-isolated-v1:${sessionId}` : sessionId,
    prefix
  );
  if (expectedSandboxId !== input.sandboxId) return undefined;
  const workspace = await input.readWorkspace(workspaceId.data);
  if (workspace?.workspaceId !== workspaceId.data || workspace.userId !== input.userId)
    return undefined;
  const orgId = workspace.organizationId ?? undefined;
  return sandboxWorkspaceOwnerSchema.parse({
    kind: 'workspace',
    workspaceId: workspaceId.data,
    userId: input.userId,
    orgId,
    directory: getControlPlaneSessionDirectory({
      sandboxId: input.sandboxId,
      sandboxKind: input.sandboxKind,
      workspacePath: getWorktreeWorkspacePath(orgId, input.userId, workspaceId.data),
      orgId,
      userId: input.userId,
      sessionId,
    }),
  });
}

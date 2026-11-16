import { z } from 'zod';

export const MAX_WORKSPACE_REPOSITORIES = 64;
export const REPOSITORY_ACCESS_PROTOCOL_VERSION = 2;
export const repositoryAccessModeSchema = z.enum(['read', 'contribute']);
export type RepositoryAccessMode = z.infer<typeof repositoryAccessModeSchema>;
const repositoryPart = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_.-]+$/)
  .refine(value => value !== '.' && value !== '..');
export const workspaceGitHubRepositoryAccessSchema = z
  .object({
    repositoryId: z.number().int().positive().safe(),
    nodeId: z.string().min(1).max(256),
    owner: repositoryPart,
    name: repositoryPart,
    mode: repositoryAccessModeSchema,
    source: z.enum(['environment', 'user']),
    approvedBy: z.string().min(1),
    approvedAt: z.number().int().nonnegative().safe(),
    integrationId: z.string().uuid(),
    gitAuthor: z
      .object({ name: z.string().min(1).max(256), email: z.string().min(1).max(320) })
      .strict()
      .optional(),
    identity: z
      .object({
        source: z.enum(['user', 'installation']),
        providerSubjectId: z.string().min(1),
        appType: z.enum(['standard', 'lite']),
      })
      .strict(),
  })
  .strict();
export type WorkspaceGitHubRepositoryAccess = z.infer<typeof workspaceGitHubRepositoryAccessSchema>;
export const workspaceRepositoryAccessSchema = z
  .object({
    version: z.literal(1),
    scopeId: z.string().min(1).max(256),
    revision: z.number().int().nonnegative().safe(),
    repositories: z.array(workspaceGitHubRepositoryAccessSchema),
  })
  .strict()
  .refine(
    value =>
      new Set(value.repositories.map(repo => repo.repositoryId)).size === value.repositories.length,
    'Duplicate repository'
  )
  .refine(
    value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 4 * 1024 * 1024,
    'Repository policy is too large'
  );
export type WorkspaceRepositoryAccess = z.infer<typeof workspaceRepositoryAccessSchema>;
export const repositoryAccessChangeSchema = z
  .object({
    sessionId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative().safe(),
    repositoryId: z.number().int().positive().safe(),
    mode: z.enum(['read', 'contribute', 'remove']),
  })
  .strict();
export type RepositoryAccessChange = z.infer<typeof repositoryAccessChangeSchema>;
export const repositoryAccessViewSchema = z.object({
  revision: z.number().int().nonnegative().safe(),
  repositories: z.array(
    workspaceGitHubRepositoryAccessSchema.pick({
      repositoryId: true,
      owner: true,
      name: true,
      mode: true,
      source: true,
    })
  ),
});
export type RepositoryAccessView = z.infer<typeof repositoryAccessViewSchema>;
export function repositoryAccessView(access: WorkspaceRepositoryAccess): RepositoryAccessView {
  return {
    revision: access.revision,
    repositories: access.repositories.map(({ repositoryId, owner, name, mode, source }) => ({
      repositoryId,
      owner,
      name,
      mode,
      source,
    })),
  };
}
export type RepositoryAccessFailure =
  | 'repository_access_required'
  | 'repository_read_only'
  | 'operation_not_supported'
  | 'authorization_unavailable'
  | 'separate_repository_requests_required';

/** Omitted provider permissions are excluded by GitHub. Workflow changes remain unsupported. */
export function githubRepositoryPermissions(mode: RepositoryAccessMode) {
  return {
    contents: mode === 'contribute' ? 'write' : 'read',
    issues: mode === 'contribute' ? 'write' : 'read',
    pull_requests: mode === 'contribute' ? 'write' : 'read',
    metadata: 'read',
    actions: 'read',
    checks: 'read',
    statuses: 'read',
  } as const;
}
/** Reject unknown permissions and any permission broader than the requested permission. */
export function githubPermissionsAreRestricted(
  value: unknown,
  mode: RepositoryAccessMode
): boolean {
  const parsed = z.record(z.string(), z.string()).safeParse(value);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return false;
  const expected: Record<string, string> = githubRepositoryPermissions(mode);
  return (
    Object.entries(parsed.data).every(
      ([name, level]) =>
        expected[name] === level || (expected[name] === 'write' && level === 'read')
    ) &&
    parsed.data.contents !== undefined &&
    parsed.data.metadata === 'read'
  );
}

export type PrepareWorkspaceRepositoryParams = {
  userId: string;
  orgId?: string;
  repositoryId?: number;
  githubRepo?: string;
  mode: RepositoryAccessMode;
  source: 'environment' | 'user';
  existing?: WorkspaceGitHubRepositoryAccess;
  expectedIntegrationId?: string;
  expectedSource?: 'user' | 'installation';
  accessPurpose?: 'workflow' | 'agent';
  persistedCapability?: string;
};
export type PrepareWorkspaceRepositoryResult =
  | { success: true; repository: WorkspaceGitHubRepositoryAccess }
  | {
      success: false;
      reason: 'authorization_unavailable' | 'repository_access_required' | 'repository_read_only';
    };

/** Service-binding-only input. These claims come from the decoded signed capability. */
export type WorkspaceRepositoryPolicyLookup = {
  sandboxId?: string;
  userId: string;
  orgId?: string;
  scopeId?: string;
  outboundContainerId: string;
  owner: string;
  name: string;
  source: 'user' | 'installation';
  installationId: string;
  appType: 'standard' | 'lite';
  gitAuthor: { name: string; email: string };
};
export type WorkspaceRepositoryPolicyResult = {
  sandboxId: string;
  access: WorkspaceRepositoryAccess;
} | null;

export type WorkspaceRepositoryScope = {
  sandboxId: string;
  scopeId: string;
  userId: string;
  orgId?: string;
  outboundContainerId: string;
};
export type IssueWorkspaceGitHubCapabilityParams = WorkspaceRepositoryScope & {
  repository?: string;
};
export type IssueWorkspaceGitHubCapabilityResult =
  | {
      success: true;
      capability: string;
      attribution?: {
        author?: { name: string; email: string };
        appType: 'standard' | 'lite';
        source: 'user' | 'installation';
      };
    }
  | { success: false; reason: 'authorization_unavailable' };

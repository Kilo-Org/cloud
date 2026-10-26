import { z } from 'zod';

export function isGitHubTaskRef(value: string): boolean {
  return (
    value.startsWith('refs/heads/') &&
    value.length <= 1024 &&
    ![...value].some(
      character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
    ) &&
    !/[~^:?*[\\]/.test(value) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.endsWith('.') &&
    value
      .split('/')
      .every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
  );
}

const repositoryPart = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_.-]+$/)
  .refine(value => value !== '.' && value !== '..');

export const githubTaskGrantSchema = z
  .object({
    revision: z.literal(1),
    scopeId: z.string().min(1).max(256),
    repository: z
      .object({
        id: z.number().int().positive().safe(),
        nodeId: z.string().min(1).max(256),
        owner: repositoryPart,
        name: repositoryPart,
      })
      .strict(),
    taskRef: z.string().refine(isGitHubTaskRef),
  })
  .strict();

export type GitHubTaskGrant = z.infer<typeof githubTaskGrantSchema>;

export const githubTaskScopeSchema = githubTaskGrantSchema
  .pick({ scopeId: true, taskRef: true })
  .extend({
    repositoryId: z.number().int().positive().safe().optional(),
  })
  .strict();
export type GitHubTaskScope = z.infer<typeof githubTaskScopeSchema>;

export type GitHubTaskPolicyFailure =
  | 'invalid_upstream_url'
  | 'upstream_host_not_allowed'
  | 'repository_mismatch'
  | 'invalid_upstream_request'
  | 'operation_not_allowed'
  | 'ref_not_allowed';

/** The broker must satisfy every check before it releases upstream authorization. */
export type GitHubTaskCheck =
  | { kind: 'repository-read'; owner: string; name: string }
  | { kind: 'owner-read' }
  | { kind: 'repository-pull-request-node'; nodeId: string }
  | { kind: 'repository-issue-node'; nodeId: string }
  | { kind: 'repository-subject-node'; nodeId: string };

export type GitHubTaskDecision =
  | { allowed: true; operation: 'read' | 'write'; checks: GitHubTaskCheck[] }
  | { allowed: false; reason: GitHubTaskPolicyFailure };

export const allowGitHubTaskRequest = (checks: GitHubTaskCheck[] = []): GitHubTaskDecision => ({
  allowed: true,
  operation: 'write',
  checks,
});

export const allowGitHubTaskRead = (checks: GitHubTaskCheck[] = []): GitHubTaskDecision => ({
  allowed: true,
  operation: 'read',
  checks,
});

export const denyGitHubTaskRequest = (reason: GitHubTaskPolicyFailure): GitHubTaskDecision => ({
  allowed: false,
  reason,
});

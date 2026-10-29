import { z } from 'zod';
import {
  isSafeRepositoryLeaf,
  normalizeRepoFullName,
  sameRepositoryIdentity,
  type EnvironmentReference,
  type EnvironmentRepositoryIdentity,
} from '@kilocode/cloud-agent-profile';
import { branchNameSchema } from '../persistence/schemas.js';

/**
 * The authorized environment of a session or a build. Two levels share one
 * shape and differ only in the branch of each V2 repository:
 *
 * - The environment scope (`environmentScopeSchema`) is what the environment
 *   itself defines. A build and a published snapshot are bound to it, because a
 *   builder clones every repository at its default branch.
 * - The session reference (`environmentReferenceSchema`) is a scope plus the
 *   branch each repository of one session resolved to. Session preflight
 *   produces the scope; session registration adds the branches. It rides session
 *   metadata, the Session DO registration and the Sandbox DO route as DO-private
 *   data. It never reaches a wrapper frame.
 *
 * Each level has two exclusive alternatives. A V1 value stores `repository`; a
 * V2 value stores `repositories`. A value with neither or with both is invalid.
 */
export const environmentRepositoryIdentitySchema = z.discriminatedUnion('platform', [
  z.object({ platform: z.literal('github'), repoFullName: z.string().min(1).max(500) }).strict(),
  z.object({ platform: z.literal('gitlab'), cloneUrl: z.string().min(1).max(2048) }).strict(),
  z
    .object({
      platform: z.literal('bitbucket'),
      workspaceUuid: z.string().min(1).max(64),
      repositoryUuid: z.string().min(1).max(64),
    })
    .strict(),
]);

export const environmentOwnerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), id: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal('organization'), id: z.string().uuid() }).strict(),
]);

const scopeRepositoryFields = {
  identity: environmentRepositoryIdentitySchema,
  repoFullName: z.string().min(1).max(500),
  leaf: z.string().max(255).refine(isSafeRepositoryLeaf, 'Unsafe repository directory name'),
};

/** One repository of a V2 environment. */
export const environmentScopeRepositorySchema = z.object(scopeRepositoryFields).strict();

/** One repository of a V2 session: the environment's repository and its resolved branch. */
export const environmentReferenceRepositorySchema = z
  .object({ ...scopeRepositoryFields, branch: branchNameSchema })
  .strict();

const referenceBaseFields = {
  environmentId: z.string().uuid(),
  owner: environmentOwnerSchema,
  configurationRevision: z.number().int().positive(),
};

export const environmentScopeV1Schema = z
  .object({
    ...referenceBaseFields,
    repository: environmentRepositoryIdentitySchema,
    repositories: z.undefined().optional(),
  })
  .strict();

export const environmentScopeV2Schema = z
  .object({
    ...referenceBaseFields,
    repositories: z.array(environmentScopeRepositorySchema).min(1),
    repository: z.undefined().optional(),
  })
  .strict();

export const environmentScopeSchema = z.union([environmentScopeV1Schema, environmentScopeV2Schema]);

export const environmentReferenceSchema = z.union([
  environmentScopeV1Schema,
  z
    .object({
      ...referenceBaseFields,
      repositories: z.array(environmentReferenceRepositorySchema).min(1),
      repository: z.undefined().optional(),
    })
    .strict(),
]);

export type EnvironmentScope = z.infer<typeof environmentScopeSchema>;
export type SessionEnvironmentReference = z.infer<typeof environmentReferenceSchema>;
export type SessionEnvironmentRepository = z.infer<typeof environmentReferenceRepositorySchema>;

// The profile package owns the environment-level shapes; the schemas above must
// accept every value it produces and produce nothing it rejects.
type AssertAssignable<T extends U, U> = T;
export type _ProfileReferenceIsScope = AssertAssignable<EnvironmentReference, EnvironmentScope>;
export type _ScopeIsProfileReference = AssertAssignable<EnvironmentScope, EnvironmentReference>;
export type _RepositoryMatchesProfilePackage = AssertAssignable<
  EnvironmentRepositoryIdentity,
  z.infer<typeof environmentRepositoryIdentitySchema>
>;

/**
 * Where each repository of a V2 session checks out its branch. The launch
 * repository takes its upstream branch, or the generated branch. An additional
 * repository takes the branch the client requested for it, or the generated
 * branch.
 */
export type SessionReferenceBranches = {
  /** The generated `kilo/<slug>` branch of this session. */
  generatedBranch: string;
  /** The identity of the repository the session launched on. */
  launch: EnvironmentRepositoryIdentity;
  /** `repository.branch` of the launch repository. */
  launchBranch: string | undefined;
  /** Requested branches of additional repositories, from `requestedEnvironment`. */
  requested: ReadonlyArray<{ repoFullName: string; branch?: string }>;
};

/**
 * The one conversion from an environment scope to a session reference. A V1
 * scope is the V1 reference. A V2 scope gains the branch of each repository.
 */
export function sessionReferenceOf(
  scope: EnvironmentScope,
  branches: SessionReferenceBranches
): SessionEnvironmentReference {
  if (scope.repositories === undefined) return scope;
  const requested = new Map(
    branches.requested.map(entry => [normalizeRepoFullName(entry.repoFullName), entry.branch])
  );
  return {
    ...scope,
    repositories: scope.repositories.map(repository => ({
      ...repository,
      branch: sameRepositoryIdentity(repository.identity, branches.launch)
        ? (branches.launchBranch ?? branches.generatedBranch)
        : (requested.get(normalizeRepoFullName(repository.repoFullName)) ??
          branches.generatedBranch),
    })),
  };
}

// The predicate lives with the layout it decides; re-exported for existing callers.
export { isMultiRepositoryEnvironment } from '../shared/environment-workspace.js';

/** Anything that carries an environment scope: a reference or a published descriptor. */
export type EnvironmentScopeLike = {
  environmentId: string;
  owner: { type: string; id: string };
  repository?: EnvironmentRepositoryIdentity;
  repositories?: ReadonlyArray<{ repoFullName: string }>;
};

function normalizeScopePath(path: string): string {
  return path.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Same environment, owner and repositories; revisions are compared by the caller.
 * An environment is V1 or V2 for life, so two values of one environment have the
 * same alternative. V1 values compare by identity, which a Bitbucket repository
 * has no path for. V2 values compare by their ordered repository paths, so a
 * reference (whose repositories carry identities) and a published descriptor
 * (whose repositories carry commits) compare equal when they list the same
 * repositories.
 */
export function sameEnvironmentScope(
  left: EnvironmentScopeLike,
  right: EnvironmentScopeLike
): boolean {
  if (
    left.environmentId !== right.environmentId ||
    left.owner.type !== right.owner.type ||
    left.owner.id !== right.owner.id
  ) {
    return false;
  }
  if (left.repository !== undefined || right.repository !== undefined) {
    return (
      left.repository !== undefined &&
      right.repository !== undefined &&
      sameRepositoryIdentity(left.repository, right.repository)
    );
  }
  const leftPaths = (left.repositories ?? []).map(entry => normalizeScopePath(entry.repoFullName));
  const rightPaths = (right.repositories ?? []).map(entry =>
    normalizeScopePath(entry.repoFullName)
  );
  return (
    leftPaths.length === rightPaths.length &&
    leftPaths.every((path, index) => path === rightPaths[index])
  );
}

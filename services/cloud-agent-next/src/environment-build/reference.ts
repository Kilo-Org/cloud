import { z } from 'zod';
import type {
  EnvironmentReference,
  EnvironmentRepositoryIdentity,
} from '@kilocode/cloud-agent-profile';

/**
 * The authorized environment a session admitted (plan "Session launch"). Session
 * preflight produces it after it authorized the environment and the repository;
 * it rides session metadata, the Session DO registration and the Sandbox DO
 * route as DO-private data, like the credential source. It never reaches a
 * wrapper frame.
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

export const environmentReferenceSchema = z
  .object({
    environmentId: z.string().uuid(),
    owner: environmentOwnerSchema,
    configurationRevision: z.number().int().positive(),
    repository: environmentRepositoryIdentitySchema,
  })
  .strict();

export type SessionEnvironmentReference = z.infer<typeof environmentReferenceSchema>;

// The profile package owns the shape; this schema must accept every value it produces.
type AssertAssignable<T extends U, U> = T;
export type _ReferenceMatchesProfilePackage = AssertAssignable<
  EnvironmentReference,
  SessionEnvironmentReference
>;
export type _RepositoryMatchesProfilePackage = AssertAssignable<
  EnvironmentRepositoryIdentity,
  z.infer<typeof environmentRepositoryIdentitySchema>
>;

function sameRepository(
  left: EnvironmentRepositoryIdentity,
  right: EnvironmentRepositoryIdentity
): boolean {
  switch (left.platform) {
    case 'github':
      return (
        right.platform === 'github' &&
        left.repoFullName.toLowerCase() === right.repoFullName.toLowerCase()
      );
    case 'gitlab':
      return right.platform === 'gitlab' && left.cloneUrl === right.cloneUrl;
    case 'bitbucket':
      return (
        right.platform === 'bitbucket' &&
        left.workspaceUuid.toLowerCase() === right.workspaceUuid.toLowerCase() &&
        left.repositoryUuid.toLowerCase() === right.repositoryUuid.toLowerCase()
      );
  }
}

/** Same environment, owner and repository; revisions are compared by the caller. */
export function sameEnvironmentScope(
  left: Pick<SessionEnvironmentReference, 'environmentId' | 'owner' | 'repository'>,
  right: Pick<SessionEnvironmentReference, 'environmentId' | 'owner' | 'repository'>
): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.owner.type === right.owner.type &&
    left.owner.id === right.owner.id &&
    sameRepository(left.repository, right.repository)
  );
}

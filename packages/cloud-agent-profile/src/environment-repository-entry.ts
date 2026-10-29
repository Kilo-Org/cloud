import * as z from 'zod';
import {
  isSafeRepositoryLeaf,
  normalizeBitbucketUuid,
  normalizeGitlabCloneUrl,
  normalizeRepoFullName,
  repositoryLeaf,
} from './environment-contracts';

/**
 * One member of a V2 environment, as stored in `cloud_agent_environments.repositories`.
 * Each field is normalized by the function the V1 identity columns use
 * (`resolveEnvironmentIdentity`), so a jsonb containment query matches exactly.
 * `repoFullName` is required for every platform: the leaf and the Bitbucket
 * clone URL come from it.
 *
 * Validate with this schema on every write and every read of the column.
 */
const repoFullNameSchema = z.string().transform(normalizeRepoFullName).pipe(z.string().min(1));
const gitlabCloneUrlSchema = z.string().transform(normalizeGitlabCloneUrl).pipe(z.string().min(1));
const bitbucketUuidSchema = z.string().trim().pipe(z.uuid()).transform(normalizeBitbucketUuid);

export const environmentRepositoryEntrySchema = z.discriminatedUnion('platform', [
  z.strictObject({ platform: z.literal('github'), repoFullName: repoFullNameSchema }),
  z.strictObject({
    platform: z.literal('gitlab'),
    repoFullName: repoFullNameSchema,
    gitlabCloneUrl: gitlabCloneUrlSchema,
  }),
  z.strictObject({
    platform: z.literal('bitbucket'),
    repoFullName: repoFullNameSchema,
    bitbucketWorkspaceUuid: bitbucketUuidSchema,
    bitbucketRepositoryUuid: bitbucketUuidSchema,
  }),
]);

export type EnvironmentRepositoryEntry = z.infer<typeof environmentRepositoryEntrySchema>;

function identityKey(entry: EnvironmentRepositoryEntry): string {
  switch (entry.platform) {
    case 'github':
      return `github:${entry.repoFullName}`;
    case 'gitlab':
      return `gitlab:${entry.gitlabCloneUrl}`;
    case 'bitbucket':
      return `bitbucket:${entry.bitbucketWorkspaceUuid}:${entry.bitbucketRepositoryUuid}`;
  }
}

/**
 * The ordered members of a V2 environment. Rejects an empty list, a repository
 * listed twice, a repository whose leaf is not a safe directory name, and two
 * repositories whose leaves are equal without regard to case. Every error names
 * the repositories.
 */
export const environmentRepositoriesSchema = z
  .array(environmentRepositoryEntrySchema)
  .min(1, 'An environment needs at least one repository')
  .superRefine((entries, ctx) => {
    const seenIdentities = new Map<string, string>();
    const seenLeaves = new Map<string, string>();
    entries.forEach((entry, index) => {
      const name = entry.repoFullName;
      const reject = (message: string) => ctx.addIssue({ code: 'custom', message, path: [index] });

      const leaf = repositoryLeaf(name);
      if (!isSafeRepositoryLeaf(leaf)) {
        reject(`Repository ${name} cannot be checked out: its directory name "${leaf}" is unsafe`);
        return;
      }

      const identity = identityKey(entry);
      if (seenIdentities.has(identity)) {
        reject(`Repository ${name} is listed more than once`);
        return;
      }
      seenIdentities.set(identity, name);

      const leafKey = leaf.toLowerCase();
      const other = seenLeaves.get(leafKey);
      if (other !== undefined) {
        reject(`Repositories ${other} and ${name} use the same directory name "${leaf}"`);
        return;
      }
      seenLeaves.set(leafKey, name);
    });
  });

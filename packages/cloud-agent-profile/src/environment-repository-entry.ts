import * as z from 'zod';
import {
  isSafeRepositoryLeaf,
  repositoryLeaf,
  environmentRepositoryEntrySchema,
  type EnvironmentRepositoryEntry,
} from './environment-contracts';

export {
  environmentRepositoryEntrySchema,
  type EnvironmentRepositoryEntry,
} from './environment-contracts';

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

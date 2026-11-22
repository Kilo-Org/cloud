import { isSafeRepositoryLeaf, repositoryLeaf } from '@kilocode/cloud-agent-profile';
import { z } from 'zod';
import { hostedGitHubRepositoryIdentitySchema } from '../shared/control-plane-protocol.js';

export const hostedGitHubRepositoriesSchema = z
  .object({
    integrationId: z.string().uuid(),
    primary: hostedGitHubRepositoryIdentitySchema,
    additional: z.array(hostedGitHubRepositoryIdentitySchema).min(1).max(5),
  })
  .strict()
  .refine(({ primary, additional }) => {
    const repositories = [primary, ...additional];
    const leaves = repositories.map(repository => repositoryLeaf(repository.fullName));
    return (
      leaves.every(isSafeRepositoryLeaf) &&
      new Set(leaves.map(leaf => leaf.toLowerCase())).size === repositories.length &&
      new Set(repositories.map(repository => repository.id)).size === repositories.length
    );
  }, 'Hosted repositories must have distinct IDs and safe, distinct checkout directories')
  .transform(repositories => ({
    ...repositories,
    additional: repositories.additional.toSorted((left, right) => left.id - right.id),
  }));

export type HostedGitHubRepositories = z.infer<typeof hostedGitHubRepositoriesSchema>;

export function sameHostedGitHubRepositories(
  left: HostedGitHubRepositories | undefined,
  right: HostedGitHubRepositories | undefined
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

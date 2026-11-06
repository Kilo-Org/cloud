import type {
  EnvironmentOwner,
  EnvironmentRepositoryEntry,
  SetupSecretRequestInput,
} from '@kilocode/cloud-agent-profile';
import { captureException } from '@sentry/nextjs';
import type { Owner } from '@/lib/integrations/core/types';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import {
  fetchGitHubRepositoryDefaultBranch,
  fetchGitHubRootTextFileAtRef,
  generateGitHubInstallationToken,
} from '@/lib/integrations/platforms/github/adapter';

const MAX_REFERENCES = 10;
const PLATFORM_GITHUB = 'github';

function integrationOwner(owner: EnvironmentOwner): Owner {
  return owner.type === 'organization'
    ? { type: 'org', id: owner.id }
    : { type: 'user', id: owner.id };
}

function splitRepoFullName(repoFullName: string): { owner: string; repo: string } | null {
  const [owner, repo, ...rest] = repoFullName.split('/');
  if (!owner || !repo || rest.length > 0) return null;
  return { owner, repo };
}

function referenceContentKey(repoFullName: string, path: string): string {
  return `${repoFullName}\u0000${path}`;
}

export async function verifySecretReferences(
  owner: EnvironmentOwner,
  draftRepositories: EnvironmentRepositoryEntry[],
  requests: SetupSecretRequestInput[]
): Promise<SetupSecretRequestInput[]> {
  const githubRepos = new Set(
    draftRepositories
      .filter(repository => repository.platform === PLATFORM_GITHUB)
      .map(repository => repository.repoFullName)
  );

  const pairs: { repoFullName: string; path: string }[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    for (const reference of request.references) {
      if (!githubRepos.has(reference.repoFullName)) continue;
      const key = referenceContentKey(reference.repoFullName, reference.path);
      if (seen.has(key) || pairs.length >= MAX_REFERENCES) continue;
      seen.add(key);
      pairs.push({ repoFullName: reference.repoFullName, path: reference.path });
    }
  }
  if (pairs.length === 0) return requests;

  const integration = await getIntegrationForOwner(integrationOwner(owner), PLATFORM_GITHUB);
  if (!integration?.platform_installation_id) return requests;

  let token: string;
  try {
    const installationToken = await generateGitHubInstallationToken(
      integration.platform_installation_id,
      integration.github_app_type ?? 'standard',
      integration.id,
      'agent'
    );
    token = installationToken.token;
  } catch (error) {
    captureException(error, {
      tags: { source: 'environment-setup', op: 'secret-reference-token' },
    });
    return requests;
  }

  const refsByRepo = new Map<string, string>();
  const contents = new Map<string, string | null>();
  for (const pair of pairs) {
    const split = splitRepoFullName(pair.repoFullName);
    if (!split) continue;
    try {
      let ref = refsByRepo.get(pair.repoFullName);
      if (ref === undefined) {
        ref = await fetchGitHubRepositoryDefaultBranch({
          token,
          owner: split.owner,
          repo: split.repo,
        });
        refsByRepo.set(pair.repoFullName, ref);
      }
      contents.set(
        referenceContentKey(pair.repoFullName, pair.path),
        await fetchGitHubRootTextFileAtRef({
          token,
          owner: split.owner,
          repo: split.repo,
          path: pair.path,
          ref,
        })
      );
    } catch (error) {
      captureException(error, {
        tags: { source: 'environment-setup', op: 'secret-reference-fetch' },
        extra: { repoFullName: pair.repoFullName, path: pair.path },
      });
    }
  }

  return requests.map(request => ({
    ...request,
    references: request.references.map(reference => {
      const content = contents.get(referenceContentKey(reference.repoFullName, reference.path));
      if (content === undefined) return reference;
      return { ...reference, verified: content !== null && content.includes(request.key) };
    }),
  }));
}

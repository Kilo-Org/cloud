import {
  type RepoOption as BridgeRepoOption,
  REPO_PLATFORM_LABEL_KEYS,
  type RepoPickerSection,
  type RepoPlatform,
} from '@/lib/picker-bridge';

export type RepoOption = {
  fullName: string;
  isPrivate: boolean;
  /** Provider platform; omitted rows are treated as GitHub until d1 fills it. */
  platform?: RepoPlatform;
  workspaceUuid?: string;
  repositoryUuid?: string;
};

/** Constant order for provider sections (Bitbucket only when its rows exist, i.e. an org is set). */
const PROVIDER_SECTION_ORDER: readonly RepoPlatform[] = ['github', 'gitlab', 'bitbucket'];

export function toBridgeRepo(repo: RepoOption): BridgeRepoOption {
  return {
    platform: repo.platform ?? 'github',
    fullName: repo.fullName,
    isPrivate: repo.isPrivate,
    ...(repo.workspaceUuid !== undefined ? { workspaceUuid: repo.workspaceUuid } : {}),
    ...(repo.repositoryUuid !== undefined ? { repositoryUuid: repo.repositoryUuid } : {}),
  };
}

/**
 * Assemble the picker's grouped sections: a "Recently used" section over the
 * recents, then one provider section per platform (in PROVIDER_SECTION_ORDER)
 * over the provider's non-recent rows. Each recent row appears once (under
 * recents), and Bitbucket only appears when it has rows.
 */
export function buildRepoSections({
  repositories,
  recents,
}: {
  repositories: RepoOption[];
  recents: RepoOption[];
}): RepoPickerSection[] {
  const recentKeys = new Set(
    recents.map(repo => `${repo.platform ?? 'github'}/${repo.fullName.toLowerCase()}`)
  );
  const sections: RepoPickerSection[] = [];
  if (recents.length > 0) {
    sections.push({
      key: 'recents',
      titleKey: 'agentChat.newSession.recentlyUsed',
      repos: recents.map(repo => toBridgeRepo(repo)),
    });
  }
  for (const platform of PROVIDER_SECTION_ORDER) {
    const repos = repositories.filter(repo => {
      const repoPlatform = repo.platform ?? 'github';
      return (
        repoPlatform === platform &&
        !recentKeys.has(`${repoPlatform}/${repo.fullName.toLowerCase()}`)
      );
    });
    if (repos.length > 0) {
      sections.push({
        key: platform,
        titleKey: REPO_PLATFORM_LABEL_KEYS[platform],
        repos: repos.map(repo => toBridgeRepo(repo)),
      });
    }
  }
  return sections;
}

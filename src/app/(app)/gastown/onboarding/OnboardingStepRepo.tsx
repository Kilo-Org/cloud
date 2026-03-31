'use client';

import { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useUser } from '@/hooks/useUser';
import { RepositoryCombobox, type RepositoryOption } from '@/components/shared/RepositoryCombobox';
import { Button } from '@/components/ui/button';
import { ExternalLink, GitBranch } from 'lucide-react';
import { useOnboarding } from './OnboardingContext';
import { resolveGitUrlFromRepo } from './onboarding.domain';

export function OnboardingStepRepo() {
  const { state, setRepo, setTownName } = useOnboarding();
  const { data: user } = useUser();
  const mainTrpc = useTRPC();

  const [selectedRepoFullName, setSelectedRepoFullName] = useState(state.repo?.fullName ?? '');

  // Use org-scoped endpoints when onboarding within an org, personal otherwise
  const orgId = state.orgId;

  const githubReposQuery = useQuery({
    ...(orgId
      ? mainTrpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId: orgId,
          forceRefresh: false,
        })
      : mainTrpc.cloudAgent.listGitHubRepositories.queryOptions({ forceRefresh: false })),
  });

  const gitlabReposQuery = useQuery({
    ...(orgId
      ? mainTrpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
          organizationId: orgId,
          forceRefresh: false,
        })
      : mainTrpc.cloudAgent.listGitLabRepositories.queryOptions({ forceRefresh: false })),
  });

  const unifiedRepositories = useMemo<RepositoryOption[]>(() => {
    const github = (githubReposQuery.data?.repositories ?? []).map(repo => ({
      id: repo.id,
      fullName: repo.fullName,
      private: repo.private,
      platform: 'github' as const,
    }));
    const gitlab = (gitlabReposQuery.data?.repositories ?? []).map(repo => ({
      id: repo.id,
      fullName: repo.fullName,
      private: repo.private,
      platform: 'gitlab' as const,
    }));
    return [...github, ...gitlab];
  }, [githubReposQuery.data, gitlabReposQuery.data]);

  const isLoadingRepos = githubReposQuery.isLoading || gitlabReposQuery.isLoading;
  // Derive integration availability from repo results (works for both personal and org scope)
  const hasAnyIntegration =
    (githubReposQuery.data?.repositories?.length ?? 0) > 0 ||
    (gitlabReposQuery.data?.repositories?.length ?? 0) > 0;

  const githubAppName = process.env.NEXT_PUBLIC_GITHUB_APP_NAME || 'KiloConnect';

  const handleInstallGithub = useCallback(() => {
    const installState = orgId ? `org_${orgId}` : `user_${user?.id}`;
    const installUrl = `https://github.com/apps/${githubAppName}/installations/new?state=${installState}`;
    window.open(installUrl, '_blank', 'noopener');
  }, [orgId, user?.id, githubAppName]);

  const handleRepoSelect = useCallback(
    (fullName: string) => {
      setSelectedRepoFullName(fullName);
      const repo = unifiedRepositories.find(r => r.fullName === fullName);
      if (!repo) return;

      const platform = repo.platform ?? 'github';
      const gitlabInstanceUrl = (gitlabReposQuery.data as { instanceUrl?: string } | undefined)
        ?.instanceUrl;
      const gitUrl = resolveGitUrlFromRepo(platform, fullName, gitlabInstanceUrl);

      // Auto-derive town name from repo name, but only if the user hasn't explicitly edited it
      const repoName = fullName.split('/').pop() ?? fullName;
      if (!state.townNameSetByUser) {
        setTownName(repoName);
      }

      setRepo({
        platform,
        fullName,
        gitUrl,
        defaultBranch: 'main',
        platformIntegrationId: undefined,
      });
    },
    [unifiedRepositories, gitlabReposQuery.data, state.townNameSetByUser, setTownName, setRepo]
  );

  return (
    <div className="flex flex-col items-center justify-center py-12">
      <h2 className="text-xl font-semibold text-white/90">Connect a repo</h2>
      <p className="mt-2 text-sm text-white/40">Choose a repository for your agents to work on.</p>

      <div className="mt-8 w-full max-w-md">
        <div className="space-y-4">
          {/* Repo picker */}
          {isLoadingRepos ? (
            <div className="space-y-2">
              <div className="h-9 w-full animate-pulse rounded-md bg-white/[0.06]" />
              <p className="text-xs text-white/30">Loading repositories...</p>
            </div>
          ) : hasAnyIntegration ? (
            <RepositoryCombobox
              repositories={unifiedRepositories}
              value={selectedRepoFullName}
              onValueChange={handleRepoSelect}
              isLoading={isLoadingRepos}
              placeholder="Select a repository..."
              searchPlaceholder="Search repositories..."
              groupByPlatform
              hideLabel
            />
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm text-white/50">
                No integrations connected yet. Install the GitHub App to see your repos.
              </div>
            </div>
          )}

          {/* Install GitHub App button when no GitHub repos found */}
          {!isLoadingRepos && (githubReposQuery.data?.repositories?.length ?? 0) === 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={handleInstallGithub}
              className="w-full gap-2 border-white/10 text-white/70 hover:text-white/90"
            >
              <ExternalLink className="size-4" />
              Install GitHub App
            </Button>
          )}

          {/* Selected repo indicator */}
          {state.repo && state.repo.platform !== 'manual' && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-400/80">
              <GitBranch className="size-4" />
              <span className="truncate">{state.repo.fullName}</span>
              <span className="ml-auto text-xs text-white/30">main</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

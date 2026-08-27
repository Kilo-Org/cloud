'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import {
  buildGastownRepositoryRigInput,
  findGastownRepository,
  GastownRepositorySelector,
  type GastownRepositoryOption,
} from '@/components/gastown/GastownRepositorySelector';
import { Button } from '@/components/ui/button';
import { ExternalLink, GitBranch } from 'lucide-react';
import { useOnboarding } from './OnboardingContext';
import { buildGitHubInstallState } from '@/components/integrations/github-install-state';

export function OnboardingStepRepo() {
  const { state, setRepo, setTownName } = useOnboarding();
  const mainTrpc = useTRPC();

  const mintInstallState = useMutation(mainTrpc.githubApps.mintInstallState.mutationOptions());

  const [selectedRepoKey, setSelectedRepoKey] = useState(state.repo?.selectionKey ?? '');

  // Use org-scoped endpoints when onboarding within an org, personal otherwise
  const orgId = state.orgId;

  const githubReposQuery = useQuery({
    ...(orgId
      ? mainTrpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId: orgId,
          forceRefresh: false,
        })
      : mainTrpc.cloudAgentNext.listGitHubRepositories.queryOptions({ forceRefresh: false })),
  });

  const gitlabReposQuery = useQuery({
    ...(orgId
      ? mainTrpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
          organizationId: orgId,
          forceRefresh: false,
        })
      : mainTrpc.cloudAgentNext.listGitLabRepositories.queryOptions({ forceRefresh: false })),
  });

  const unifiedRepositories = useMemo<GastownRepositoryOption[]>(() => {
    const github = (githubReposQuery.data?.repositories ?? []).map(repo => ({
      id: repo.id,
      fullName: repo.fullName,
      private: repo.private,
      platform: 'github' as const,
      defaultBranch: repo.defaultBranch,
      platformIntegrationId: repo.platformIntegrationId,
      platformAccountLogin: repo.platformAccountLogin,
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
  const selectedRepository = findGastownRepository(unifiedRepositories, selectedRepoKey);
  // Derive integration availability from repo results (works for both personal and org scope)
  const hasAnyIntegration =
    (githubReposQuery.data?.repositories?.length ?? 0) > 0 ||
    (gitlabReposQuery.data?.repositories?.length ?? 0) > 0;

  const githubAppName = process.env.NEXT_PUBLIC_GITHUB_APP_NAME || 'KiloConnect';

  const handleInstallGithub = useCallback(async () => {
    try {
      const result = await mintInstallState.mutateAsync({
        organizationId: orgId ?? undefined,
        returnTo: `/gastown/onboarding?step=repo${orgId ? `&orgId=${orgId}` : ''}`,
      });
      const state = buildGitHubInstallState(result.token);
      const installUrl = `https://github.com/apps/${githubAppName}/installations/new?state=${encodeURIComponent(state)}`;
      window.location.href = installUrl;
    } catch (err) {
      toast.error('Failed to start GitHub installation', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }, [orgId, githubAppName, mintInstallState]);

  const githubInstallParam = useSearchParams().get('github_install');
  const { refetch: refetchGithubRepos } = githubReposQuery;

  useEffect(() => {
    if (githubInstallParam === 'success') {
      void refetchGithubRepos();
      toast.success('GitHub app installed. Select a repo to continue.');
    }
  }, [githubInstallParam, refetchGithubRepos]);

  useEffect(() => {
    if (isLoadingRepos || !selectedRepoKey || selectedRepository) return;
    setSelectedRepoKey('');
    setRepo(null);
  }, [isLoadingRepos, selectedRepoKey, selectedRepository, setRepo]);

  const handleRepoSelect = useCallback(
    (selectionKey: string) => {
      setSelectedRepoKey(selectionKey);
      const repo = findGastownRepository(unifiedRepositories, selectionKey);
      if (!repo) return;

      const platform = repo.platform ?? 'github';
      if (platform === 'bitbucket') {
        // TODO: Add Bitbucket support to Gastown.
        return;
      }
      const gitlabInstanceUrl = (gitlabReposQuery.data as { instanceUrl?: string } | undefined)
        ?.instanceUrl;
      const rigInput = buildGastownRepositoryRigInput(repo, gitlabInstanceUrl, unifiedRepositories);
      if (!rigInput) return;

      // Auto-derive town name from repo name, but only if the user hasn't explicitly edited it
      const repoName = repo.fullName.split('/').pop() ?? repo.fullName;
      if (!state.townNameSetByUser) {
        setTownName(repoName);
      }

      setRepo({
        platform,
        selectionKey,
        fullName: repo.fullName,
        ...rigInput,
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
              <div className="h-11 w-full animate-pulse rounded-md bg-white/[0.06] sm:h-9" />
              <p className="text-xs text-white/30">Loading repositories...</p>
            </div>
          ) : hasAnyIntegration ? (
            <GastownRepositorySelector
              repositories={unifiedRepositories}
              value={selectedRepoKey}
              onValueChange={handleRepoSelect}
              isLoading={isLoadingRepos}
              placeholder="Select a repository..."
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
              disabled={mintInstallState.isPending}
              className="w-full gap-2 border-white/10 text-white/70 hover:text-white/90"
            >
              <ExternalLink className="size-4" />
              {mintInstallState.isPending ? 'Starting installation...' : 'Install GitHub App'}
            </Button>
          )}

          {/* Selected repo indicator */}
          {state.repo && state.repo.platform !== 'manual' && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-400/80">
              <GitBranch className="size-4" />
              <span className="min-w-0 truncate" title={state.repo.fullName}>
                {state.repo.fullName}
              </span>
              <span className="ml-auto shrink-0 text-xs text-white/30">
                {state.repo.defaultBranch}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useUser } from '@/hooks/useUser';
import { RepositoryCombobox, type RepositoryOption } from '@/components/shared/RepositoryCombobox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ExternalLink, GitBranch, Link2 } from 'lucide-react';
import { useOnboarding } from './OnboardingContext';
import { resolveGitUrlFromRepo } from './onboarding.domain';

type InputMode = 'picker' | 'manual';

export function OnboardingStepRepo() {
  const { state, setRepo, setTownName, goNext } = useOnboarding();
  const { data: user } = useUser();
  const mainTrpc = useTRPC();

  const [mode, setMode] = useState<InputMode>(
    state.repo?.platform === 'manual' ? 'manual' : 'picker'
  );
  const [selectedRepoFullName, setSelectedRepoFullName] = useState(
    state.repo?.platform !== 'manual' ? (state.repo?.fullName ?? '') : ''
  );
  const [manualGitUrl, setManualGitUrl] = useState(
    state.repo?.platform === 'manual' ? (state.repo?.gitUrl ?? '') : ''
  );
  const [manualBranch, setManualBranch] = useState(
    state.repo?.platform === 'manual' ? (state.repo?.defaultBranch ?? 'main') : 'main'
  );

  // Use org-scoped endpoints when onboarding within an org, personal otherwise
  const orgId = state.orgId;

  const githubReposQuery = useQuery({
    ...(orgId
      ? mainTrpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId: orgId,
          forceRefresh: false,
        })
      : mainTrpc.cloudAgent.listGitHubRepositories.queryOptions({ forceRefresh: false })),
    enabled: mode === 'picker',
  });

  const gitlabReposQuery = useQuery({
    ...(orgId
      ? mainTrpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
          organizationId: orgId,
          forceRefresh: false,
        })
      : mainTrpc.cloudAgent.listGitLabRepositories.queryOptions({ forceRefresh: false })),
    enabled: mode === 'picker',
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
    window.location.href = installUrl;
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
    [unifiedRepositories, gitlabReposQuery.data, state.townName, setTownName, setRepo]
  );

  const handleManualConfirm = useCallback(() => {
    const trimmedUrl = manualGitUrl.trim();
    if (!trimmedUrl) return;

    // Derive a name from the URL for rig naming
    const urlName = trimmedUrl
      .replace(/\.git$/, '')
      .split('/')
      .pop();

    setRepo({
      platform: 'manual',
      fullName: urlName ?? 'repo',
      gitUrl: trimmedUrl,
      defaultBranch: manualBranch.trim() || 'main',
    });

    goNext();
  }, [manualGitUrl, manualBranch, setRepo, goNext]);

  const handlePickerContinue = useCallback(() => {
    if (state.repo && state.repo.platform !== 'manual') {
      goNext();
    }
  }, [state.repo, goNext]);

  const isPickerReady = state.repo !== null && state.repo.platform !== 'manual';
  const isManualReady = manualGitUrl.trim().length > 0;

  return (
    <div className="flex flex-col items-center justify-center py-12">
      <h2 className="text-xl font-semibold text-white/90">Connect a repo</h2>
      <p className="mt-2 text-sm text-white/40">Choose a repository for your agents to work on.</p>

      <div className="mt-8 w-full max-w-md">
        {mode === 'picker' ? (
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

            {/* Continue button for picker mode */}
            {isPickerReady && (
              <Button
                type="button"
                onClick={handlePickerContinue}
                className="w-full bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
              >
                Continue
              </Button>
            )}

            {/* Manual URL escape hatch */}
            <button
              type="button"
              onClick={() => setMode('manual')}
              className="flex w-full items-center justify-center gap-1.5 text-xs text-white/30 transition-colors hover:text-white/50"
            >
              <Link2 className="size-3" />
              Or enter a git URL manually
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Manual URL input */}
            <div>
              <label className="mb-2 block text-sm font-medium text-white/70">Git URL</label>
              <Input
                value={manualGitUrl}
                onChange={e => setManualGitUrl(e.target.value)}
                placeholder="https://github.com/org/repo.git"
                className="border-white/10 bg-black/25"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter' && isManualReady) {
                    handleManualConfirm();
                  }
                }}
              />
              <p className="mt-1 text-xs text-white/30">
                For private repos, you can add credentials in Town Settings later.
              </p>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-white/70">Default Branch</label>
              <Input
                value={manualBranch}
                onChange={e => setManualBranch(e.target.value)}
                placeholder="main"
                className="border-white/10 bg-black/25"
                onKeyDown={e => {
                  if (e.key === 'Enter' && isManualReady) {
                    handleManualConfirm();
                  }
                }}
              />
            </div>

            {/* Continue button */}
            <Button
              type="button"
              onClick={handleManualConfirm}
              disabled={!isManualReady}
              className="w-full bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)] disabled:opacity-50"
            >
              Continue
            </Button>

            {/* Back to picker */}
            <button
              type="button"
              onClick={() => setMode('picker')}
              className="flex w-full items-center justify-center gap-1.5 text-xs text-white/30 transition-colors hover:text-white/50"
            >
              Back to repo picker
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

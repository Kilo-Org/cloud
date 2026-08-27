'use client';

import { useEffect, useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { useTRPC } from '@/lib/trpc/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  buildGastownRepositoryRigInput,
  findGastownRepository,
  GastownRepositorySelector,
  type GastownRepositoryOption,
} from '@/components/gastown/GastownRepositorySelector';
import { toast } from 'sonner';

type CreateRigDialogProps = {
  townId: string;
  isOpen: boolean;
  onClose: () => void;
  /** When set, queries org-scoped integrations instead of personal ones. */
  organizationId?: string;
};

type RepoMode = 'integration' | 'manual';

export function CreateRigDialog({ townId, isOpen, onClose, organizationId }: CreateRigDialogProps) {
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [mode, setMode] = useState<RepoMode>('integration');
  const [selectedRepoKey, setSelectedRepoKey] = useState('');
  const trpc = useGastownTRPC();
  const mainTrpc = useTRPC();
  const queryClient = useQueryClient();

  // Fetch repos from integrations — use org-scoped queries when organizationId is provided
  const githubReposQuery = useQuery({
    ...(organizationId
      ? mainTrpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : mainTrpc.cloudAgentNext.listGitHubRepositories.queryOptions({ forceRefresh: false })),
    enabled: isOpen && mode === 'integration',
  });

  const gitlabReposQuery = useQuery({
    ...(organizationId
      ? mainTrpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : mainTrpc.cloudAgentNext.listGitLabRepositories.queryOptions({ forceRefresh: false })),
    enabled: isOpen && mode === 'integration',
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
  const selectedRepository = findGastownRepository(unifiedRepositories, selectedRepoKey);

  const hasIntegrations =
    (githubReposQuery.data?.repositories?.length ?? 0) > 0 ||
    (gitlabReposQuery.data?.repositories?.length ?? 0) > 0;

  const isLoadingRepos = githubReposQuery.isLoading || gitlabReposQuery.isLoading;

  useEffect(() => {
    if (isLoadingRepos || !selectedRepoKey || selectedRepository) return;
    setSelectedRepoKey('');
  }, [isLoadingRepos, selectedRepoKey, selectedRepository]);

  const createRig = useMutation(
    trpc.gastown.createRig.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listRigs.queryKey() });
        toast.success('Rig created');
        resetForm();
        onClose();
      },
      onError: err => {
        toast.error(err.message);
      },
    })
  );

  function resetForm() {
    setName('');
    setGitUrl('');
    setDefaultBranch('main');
    setSelectedRepoKey('');
  }

  function handleRepoSelect(selectionKey: string) {
    setSelectedRepoKey(selectionKey);
    const repo = findGastownRepository(unifiedRepositories, selectionKey);
    // TODO: Add Bitbucket support to Gastown.
    if (!repo || repo.platform === 'bitbucket') return;
    // Auto-fill name from repo name
    const repoName = repo.fullName.split('/').pop() ?? repo.fullName;
    if (!name) {
      setName(repoName);
    }
    setDefaultBranch(repo.defaultBranch || 'main');
  }

  function resolveGitUrl(): string {
    if (mode === 'manual') return gitUrl.trim();
    if (!selectedRepository) return '';
    const instanceUrl = (gitlabReposQuery.data as { instanceUrl?: string } | undefined)
      ?.instanceUrl;
    return buildGastownRepositoryRigInput(selectedRepository, instanceUrl)?.gitUrl ?? '';
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const resolvedUrl = resolveGitUrl();
    if (!name.trim() || !resolvedUrl) return;
    const repositoryInput = selectedRepository
      ? buildGastownRepositoryRigInput(
          selectedRepository,
          (gitlabReposQuery.data as { instanceUrl?: string } | undefined)?.instanceUrl
        )
      : null;
    createRig.mutate({
      townId,
      name: name.trim(),
      gitUrl: resolvedUrl,
      defaultBranch: defaultBranch.trim() || 'main',
      ...(mode === 'integration' && repositoryInput?.platformIntegrationId
        ? { platformIntegrationId: repositoryInput.platformIntegrationId }
        : {}),
    });
  };

  const canSubmit =
    name.trim() && (mode === 'manual' ? gitUrl.trim() : selectedRepository) && !createRig.isPending;

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="border-white/10 bg-[color:oklch(0.155_0_0)]">
        <DialogHeader>
          <DialogTitle>Create Rig</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div>
              <label className="mb-2 block text-sm font-medium text-white/70">Rig Name</label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="my-project"
                autoFocus
                className="border-white/10 bg-black/25"
              />
            </div>

            {/* Mode toggle */}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode('integration')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === 'integration'
                    ? 'bg-white/10 text-white/90'
                    : 'text-white/50 hover:text-white/70'
                }`}
              >
                From Integrations
              </button>
              <button
                type="button"
                onClick={() => setMode('manual')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === 'manual'
                    ? 'bg-white/10 text-white/90'
                    : 'text-white/50 hover:text-white/70'
                }`}
              >
                Manual URL
              </button>
            </div>

            {mode === 'integration' ? (
              <div>
                <label className="mb-2 block text-sm font-medium text-white/70">Repository</label>
                {!isLoadingRepos && !hasIntegrations ? (
                  <div className="rounded-md border border-white/10 bg-black/25 p-3 text-sm text-white/50">
                    No integrations connected.{' '}
                    <a
                      href={
                        organizationId
                          ? `/organizations/${organizationId}/integrations`
                          : '/integrations'
                      }
                      className="text-white/70 underline"
                    >
                      Connect GitHub or GitLab
                    </a>{' '}
                    first, or use Manual URL.
                  </div>
                ) : (
                  <GastownRepositorySelector
                    repositories={unifiedRepositories}
                    value={selectedRepoKey}
                    onValueChange={handleRepoSelect}
                    isLoading={isLoadingRepos}
                    placeholder="Select a repository..."
                  />
                )}
              </div>
            ) : (
              <div>
                <label className="mb-2 block text-sm font-medium text-white/70">Git URL</label>
                <Input
                  value={gitUrl}
                  onChange={e => setGitUrl(e.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  className="border-white/10 bg-black/25"
                />
                <p className="mt-1 text-xs text-white/40">
                  For private repos, add a token in Town Settings.
                </p>
              </div>
            )}

            <div>
              <label className="mb-2 block text-sm font-medium text-white/70">Default Branch</label>
              <Input
                value={defaultBranch}
                onChange={e => setDefaultBranch(e.target.value)}
                placeholder="main"
                className="border-white/10 bg-black/25"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="default" type="submit" disabled={!canSubmit}>
              {createRig.isPending ? 'Creating rig...' : 'Create rig'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

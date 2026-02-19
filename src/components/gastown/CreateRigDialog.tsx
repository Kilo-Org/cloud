'use client';

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/Button';
import { RepositoryCombobox, type RepositoryOption } from '@/components/shared/RepositoryCombobox';
import { toast } from 'sonner';

type CreateRigDialogProps = {
  townId: string;
  isOpen: boolean;
  onClose: () => void;
};

type RepoMode = 'integration' | 'manual';

export function CreateRigDialog({ townId, isOpen, onClose }: CreateRigDialogProps) {
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [mode, setMode] = useState<RepoMode>('integration');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState<'github' | 'gitlab' | null>(null);
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Fetch repos from integrations
  const githubReposQuery = useQuery({
    ...trpc.cloudAgent.listGitHubRepositories.queryOptions({ forceRefresh: false }),
    enabled: isOpen && mode === 'integration',
  });

  const gitlabReposQuery = useQuery({
    ...trpc.cloudAgent.listGitLabRepositories.queryOptions({ forceRefresh: false }),
    enabled: isOpen && mode === 'integration',
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

  const hasIntegrations =
    (githubReposQuery.data?.repositories?.length ?? 0) > 0 ||
    (gitlabReposQuery.data?.repositories?.length ?? 0) > 0;

  const isLoadingRepos = githubReposQuery.isLoading || gitlabReposQuery.isLoading;

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
    setSelectedRepo('');
    setSelectedPlatform(null);
  }

  function handleRepoSelect(fullName: string) {
    setSelectedRepo(fullName);
    // Determine platform from the selection
    const repo = unifiedRepositories.find(r => r.fullName === fullName);
    if (repo?.platform) {
      setSelectedPlatform(repo.platform);
    }
    // Auto-fill name from repo name
    const repoName = fullName.split('/').pop() ?? fullName;
    if (!name) {
      setName(repoName);
    }
  }

  function resolveGitUrl(): string {
    if (mode === 'manual') return gitUrl.trim();
    if (!selectedRepo) return '';
    if (selectedPlatform === 'gitlab') {
      return `https://gitlab.com/${selectedRepo}.git`;
    }
    return `https://github.com/${selectedRepo}.git`;
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const resolvedUrl = resolveGitUrl();
    if (!name.trim() || !resolvedUrl) return;
    createRig.mutate({
      townId,
      name: name.trim(),
      gitUrl: resolvedUrl,
      defaultBranch: defaultBranch.trim() || 'main',
      // platform_integration_id is stored for future automatic token
      // management. For now, tokens come from town config (#385).
      platformIntegrationId: undefined,
    });
  };

  const canSubmit =
    name.trim() && (mode === 'manual' ? gitUrl.trim() : selectedRepo) && !createRig.isPending;

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
                    <a href="/integrations" className="text-white/70 underline">
                      Connect GitHub or GitLab
                    </a>{' '}
                    first, or use Manual URL.
                  </div>
                ) : (
                  <RepositoryCombobox
                    repositories={unifiedRepositories}
                    value={selectedRepo}
                    onValueChange={handleRepoSelect}
                    isLoading={isLoadingRepos}
                    placeholder="Select a repository..."
                    searchPlaceholder="Search repositories..."
                    groupByPlatform
                    hideLabel
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
            <Button variant="secondary" size="md" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              type="submit"
              disabled={!canSubmit}
              className="bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              {createRig.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

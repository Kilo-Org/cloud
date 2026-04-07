/** Dialog for managing repo-profile bindings with repo picker. */
'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GitBranch, Plus, Loader2, Trash2, Lock, Unlock, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import {
  useRepoBindings,
  useBindRepoMutation,
  useUnbindRepoMutation,
  useProfiles,
  useCombinedProfiles,
} from '@/hooks/useCloudAgentProfiles';

type Platform = 'github' | 'gitlab';

type Repository = {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
};

type RepositoryOption = {
  id: number;
  fullName: string;
  private: boolean;
  platform: Platform;
};

type RepoProfileBindingsDialogProps = {
  organizationId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function RepoProfileBindingsDialog({
  organizationId,
  open,
  onOpenChange,
}: RepoProfileBindingsDialogProps) {
  const trpc = useTRPC();
  const [isAdding, setIsAdding] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [repoPopoverOpen, setRepoPopoverOpen] = useState(false);

  // Fetch repo bindings
  const { data: bindings, isLoading: isBindingsLoading } = useRepoBindings({
    organizationId,
    enabled: open,
  });

  // Fetch profiles
  const { data: personalProfiles } = useProfiles({
    enabled: open && !organizationId,
  });
  const { data: combinedProfiles } = useCombinedProfiles({
    organizationId: organizationId ?? '',
    enabled: open && !!organizationId,
  });

  const profiles = organizationId ? combinedProfiles?.orgProfiles : personalProfiles;

  // Fetch repositories (same pattern as NewSessionPanel)
  const { data: githubRepoData, isLoading: isLoadingGitHubRepos } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  const { data: gitlabRepoData, isLoading: isLoadingGitLabRepos } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitLabRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  const isLoadingRepos = isLoadingGitHubRepos || isLoadingGitLabRepos;

  const githubRepositories = (githubRepoData?.repositories || []) as Repository[];
  const gitlabRepositories = (gitlabRepoData?.repositories || []) as Repository[];

  const unifiedRepositories = useMemo<RepositoryOption[]>(() => {
    const github = githubRepositories.map(repo => ({
      id: repo.id,
      fullName: repo.fullName,
      private: repo.private,
      platform: 'github' as const,
    }));
    const gitlab = gitlabRepositories.map(repo => ({
      id: repo.id,
      fullName: repo.fullName,
      private: repo.private,
      platform: 'gitlab' as const,
    }));
    return [...github, ...gitlab];
  }, [githubRepositories, gitlabRepositories]);

  const hasMultiplePlatforms = githubRepositories.length > 0 && gitlabRepositories.length > 0;

  const bindRepo = useBindRepoMutation(organizationId);
  const unbindRepo = useUnbindRepoMutation(organizationId);

  const handleRepoSelect = (repoKey: string) => {
    const [platform, fullName] = repoKey.split(':');
    setSelectedRepo(`${platform}:${fullName}`);
    setRepoPopoverOpen(false);
  };

  const handleAdd = () => {
    if (!selectedRepo || !selectedProfileId) return;

    const [platform, fullName] = selectedRepo.split(':');
    const repo = unifiedRepositories.find(r => r.fullName === fullName && r.platform === platform);
    if (!repo) return;

    bindRepo.mutate(
      {
        organizationId,
        profileId: selectedProfileId,
        repoFullName: fullName,
        platform: repo.platform,
      },
      {
        onSuccess: () => {
          toast.success(`Default profile set for "${fullName}"`);
          setSelectedRepo('');
          setSelectedProfileId('');
          setIsAdding(false);
        },
        onError: () => {
          toast.error('Failed to set default profile');
        },
      }
    );
  };

  const handleCancel = () => {
    setSelectedRepo('');
    setSelectedProfileId('');
    setIsAdding(false);
  };

  const handleUnbind = (repoFullName: string, repoPlatform: string) => {
    unbindRepo.mutate(
      {
        organizationId,
        repoFullName,
        platform: repoPlatform === 'gitlab' ? 'gitlab' : 'github',
      },
      {
        onSuccess: () => {
          toast.success(`Default profile removed for "${repoFullName}"`);
        },
        onError: () => {
          toast.error('Failed to remove default profile');
        },
      }
    );
  };

  const _selectedRepoData = selectedRepo
    ? unifiedRepositories.find(r => `${r.platform}:${r.fullName}` === selectedRepo)
    : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px]">
        <DialogHeader>
          <DialogTitle>Default Profiles for Repos</DialogTitle>
          <DialogDescription>
            Set a default profile for specific repositories. When you start a session for a repo
            listed here, its profile will be applied automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] overflow-y-auto py-4">
          {isBindingsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : (
            <div className="space-y-4">
              {/* Add binding form */}
              {isAdding && (
                <div className="space-y-3 rounded-lg border p-3">
                  <div className="flex items-start gap-2">
                    {/* Repo picker with Command */}
                    <Popover open={repoPopoverOpen} onOpenChange={setRepoPopoverOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={repoPopoverOpen}
                          className="min-w-0 flex-1 justify-between"
                          disabled={isLoadingRepos}
                        >
                          <span className="truncate">
                            {selectedRepo ? selectedRepo.split(':')[1] : 'Select repository...'}
                          </span>
                          {isLoadingRepos ? (
                            <Loader2 className="ml-2 h-4 w-4 shrink-0 animate-spin" />
                          ) : null}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
                        <Command>
                          <CommandInput placeholder="Search repositories..." />
                          <CommandEmpty>No repositories match your search</CommandEmpty>
                          <CommandList className="max-h-64 overflow-auto">
                            {hasMultiplePlatforms ? (
                              <>
                                {githubRepositories.length > 0 && (
                                  <CommandGroup heading="GitHub">
                                    {githubRepositories.map(repo => (
                                      <RepoCommandItem
                                        key={repo.id}
                                        repo={{
                                          id: repo.id,
                                          fullName: repo.fullName,
                                          private: repo.private,
                                          platform: 'github',
                                        }}
                                        isSelected={`github:${repo.fullName}` === selectedRepo}
                                        onSelect={handleRepoSelect}
                                      />
                                    ))}
                                  </CommandGroup>
                                )}
                                {gitlabRepositories.length > 0 && (
                                  <CommandGroup heading="GitLab">
                                    {gitlabRepositories.map(repo => (
                                      <RepoCommandItem
                                        key={repo.id}
                                        repo={{
                                          id: repo.id,
                                          fullName: repo.fullName,
                                          private: repo.private,
                                          platform: 'gitlab',
                                        }}
                                        isSelected={`gitlab:${repo.fullName}` === selectedRepo}
                                        onSelect={handleRepoSelect}
                                      />
                                    ))}
                                  </CommandGroup>
                                )}
                              </>
                            ) : (
                              <CommandGroup>
                                {unifiedRepositories.map(repo => (
                                  <RepoCommandItem
                                    key={repo.id}
                                    repo={repo}
                                    isSelected={
                                      `${repo.platform}:${repo.fullName}` === selectedRepo
                                    }
                                    onSelect={handleRepoSelect}
                                  />
                                ))}
                              </CommandGroup>
                            )}
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>

                    {/* Profile selector */}
                    <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                      <SelectTrigger className="w-[160px] shrink-0">
                        <SelectValue placeholder="Select profile" />
                      </SelectTrigger>
                      <SelectContent>
                        {profiles?.map(p => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                            {p.isDefault ? ' (default)' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      disabled={!selectedRepo || !selectedProfileId || bindRepo.isPending}
                      onClick={handleAdd}
                    >
                      {bindRepo.isPending ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : null}
                      Add
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleCancel}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {/* Existing bindings list */}
              {!bindings || bindings.length === 0 ? (
                <div className="py-8 text-center">
                  <p className="text-muted-foreground">No defaults configured</p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Add a default to automatically apply a profile when starting sessions for a
                    repo.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {bindings.map(binding => (
                    <div
                      key={`${binding.platform}:${binding.repoFullName}`}
                      className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5"
                    >
                      <div className="flex items-center gap-2 overflow-hidden">
                        <GitBranch className="text-muted-foreground h-4 w-4 shrink-0" />
                        <span className="truncate text-sm font-medium">{binding.repoFullName}</span>
                        <Badge variant="secondary" className="shrink-0 text-[10px]">
                          {binding.platform === 'gitlab' ? 'GL' : 'GH'}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-muted-foreground truncate text-sm">
                          {binding.profileName}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive h-7 w-7 shrink-0"
                          disabled={unbindRepo.isPending}
                          onClick={() => handleUnbind(binding.repoFullName, binding.platform)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          {!isAdding && (
            <Button variant="outline" onClick={() => setIsAdding(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add default
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Internal sub-component for repo items in the Command list
// ---------------------------------------------------------------------------

function RepoCommandItem({
  repo,
  isSelected,
  onSelect,
}: {
  repo: RepositoryOption;
  isSelected: boolean;
  onSelect: (fullName: string) => void;
}) {
  return (
    <CommandItem
      value={`${repo.platform}:${repo.fullName}`}
      onSelect={onSelect}
      className="flex items-center gap-2"
    >
      {repo.private ? (
        <Lock className="size-3.5 text-yellow-500" />
      ) : (
        <Unlock className="size-3.5 text-gray-500" />
      )}
      <span className="truncate">{repo.fullName}</span>
      <Check className={cn('ml-auto h-4 w-4', isSelected ? 'opacity-100' : 'opacity-0')} />
    </CommandItem>
  );
}

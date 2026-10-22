'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Lock, Plus, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useTRPC } from '@/lib/trpc/utils';
import {
  getGitHubRepositoryNotices,
  githubIntegrationSettingsHref,
} from '../github-repository-status';
import { excludeListedRepositories } from './settings-options';

export type RepositoryOption = {
  fullName: string;
  private: boolean;
  platform: 'github' | 'gitlab';
};

const PLATFORM_HEADINGS = { github: 'GitHub', gitlab: 'GitLab' } as const;

type RepositoryPickerProps = {
  organizationId?: string;
  listed: ReadonlyArray<{ repositoryFullName: string; repositoryPlatform: string }>;
  disabled: boolean;
  onSelect: (repository: RepositoryOption) => void;
};

export function RepositoryPicker({
  organizationId,
  listed,
  disabled,
  onSelect,
}: RepositoryPickerProps) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);

  const github = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({ forceRefresh: false })
  );
  const gitlab = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitLabRepositories.queryOptions({ forceRefresh: false })
  );

  const available = useMemo(() => {
    const repositories = [
      ...(github.data?.repositories ?? []).map(repo => ({
        fullName: repo.fullName,
        private: repo.private,
        platform: 'github' as const,
      })),
      ...(gitlab.data?.repositories ?? []).map(repo => ({
        fullName: repo.fullName,
        private: repo.private,
        platform: 'gitlab' as const,
      })),
    ];
    return excludeListedRepositories(repositories, listed);
  }, [github.data, gitlab.data, listed]);

  const hasBothPlatforms =
    (github.data?.repositories.length ?? 0) > 0 && (gitlab.data?.repositories.length ?? 0) > 0;

  const githubNotices = getGitHubRepositoryNotices(
    github.data,
    githubIntegrationSettingsHref(organizationId)
  );

  const choose = (repository: RepositoryOption) => {
    setOpen(false);
    onSelect(repository);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <Plus />
          Add repository
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <Command>
          <CommandInput placeholder="Search repositories..." />
          {githubNotices.length > 0 && (
            <div className="space-y-1 border-b px-3 py-2 text-xs">
              {githubNotices.map(notice => (
                <p key={notice.kind} className="text-amber-400">
                  {notice.message}{' '}
                  {notice.kind === 'reconnect' ? (
                    <Link
                      href={notice.settingsHref}
                      className="text-link hover:text-link-hover underline underline-offset-4"
                    >
                      Review the GitHub connection
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void github.refetch()}
                      disabled={github.isFetching}
                      className="underline underline-offset-4 disabled:opacity-50"
                    >
                      {github.isFetching ? 'Refreshing...' : 'Refresh'}
                    </button>
                  )}
                </p>
              ))}
            </div>
          )}
          <CommandList className="max-h-64 overflow-auto">
            {github.isLoading || gitlab.isLoading ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                <Loader2 className="size-4 animate-spin" />
                Loading repositories...
              </div>
            ) : (
              <>
                <CommandEmpty>No repositories found</CommandEmpty>
                {hasBothPlatforms ? (
                  (['github', 'gitlab'] as const).map(platform => {
                    const repositories = available.filter(repo => repo.platform === platform);
                    return repositories.length > 0 ? (
                      <CommandGroup key={platform} heading={PLATFORM_HEADINGS[platform]}>
                        {repositories.map(repo => (
                          <RepositoryCommandItem
                            key={repo.fullName}
                            repo={repo}
                            onSelect={choose}
                          />
                        ))}
                      </CommandGroup>
                    ) : null;
                  })
                ) : (
                  <CommandGroup>
                    {available.map(repo => (
                      <RepositoryCommandItem
                        key={`${repo.platform}:${repo.fullName}`}
                        repo={repo}
                        onSelect={choose}
                      />
                    ))}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function RepositoryCommandItem({
  repo,
  onSelect,
}: {
  repo: RepositoryOption;
  onSelect: (repository: RepositoryOption) => void;
}) {
  const VisibilityIcon = repo.private ? Lock : Unlock;
  return (
    <CommandItem
      value={`${repo.platform}:${repo.fullName}`}
      onSelect={() => onSelect(repo)}
      className="flex items-center gap-2"
    >
      <VisibilityIcon
        role="img"
        aria-label={repo.private ? 'Private' : 'Public'}
        className="text-muted-foreground size-3.5 shrink-0"
      />
      <span className="truncate" title={repo.fullName}>
        {repo.fullName}
      </span>
    </CommandItem>
  );
}

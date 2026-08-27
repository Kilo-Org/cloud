'use client';

import { useRef, useState } from 'react';
import { Check, ChevronsUpDown, Lock, Unlock } from 'lucide-react';

import type { RepositoryOption } from '@/components/shared/RepositoryCombobox';
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
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export type GastownRepositoryOption = RepositoryOption & {
  defaultBranch?: string;
};

type RepositoryGroup = {
  key: string;
  label: string;
  repositories: GastownRepositoryOption[];
};

export function gastownRepositoryKey(repository: GastownRepositoryOption): string {
  return JSON.stringify([
    repository.platform ?? 'other',
    repository.platformIntegrationId ?? '',
    repository.id,
  ]);
}

export function findGastownRepository(
  repositories: GastownRepositoryOption[],
  selectionKey: string
): GastownRepositoryOption | null {
  return repositories.find(repository => gastownRepositoryKey(repository) === selectionKey) ?? null;
}

export function groupGastownRepositories(
  repositories: GastownRepositoryOption[]
): RepositoryGroup[] {
  const groups = new Map<string, RepositoryGroup>();

  for (const repository of repositories) {
    const key =
      repository.platform === 'github'
        ? `github:${repository.platformAccountLogin ?? 'GitHub'}`
        : (repository.platform ?? 'other');
    const label =
      repository.platform === 'github'
        ? (repository.platformAccountLogin ?? 'GitHub')
        : repository.platform === 'gitlab'
          ? 'GitLab'
          : 'Other';
    const group = groups.get(key);

    if (group) {
      group.repositories.push(repository);
    } else {
      groups.set(key, { key, label, repositories: [repository] });
    }
  }

  return [...groups.values()];
}

function duplicateRepositoryNames(repositories: GastownRepositoryOption[]): Set<string> {
  const counts = new Map<string, number>();
  for (const repository of repositories) {
    if (repository.platform !== 'github') continue;
    counts.set(repository.fullName, (counts.get(repository.fullName) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([fullName]) => fullName));
}

export function getGastownRepositoryDiscriminator(
  repository: GastownRepositoryOption,
  duplicateNames: ReadonlySet<string>
): string | null {
  if (repository.platform !== 'github' || !duplicateNames.has(repository.fullName)) return null;
  if (repository.platformIntegrationId) {
    return `Connection ${repository.platformIntegrationId}`;
  }
  return `Repository ${repository.id}`;
}

export function GastownRepositoryOptionLabel({
  repository,
  discriminator,
}: {
  repository: GastownRepositoryOption;
  discriminator: string | null;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col" title={repository.fullName}>
      <span className="truncate font-mono">{repository.fullName}</span>
      {discriminator && (
        <span className="text-muted-foreground truncate text-[11px]" title={discriminator}>
          {discriminator}
        </span>
      )}
    </span>
  );
}

export function buildGastownRepositoryRigInput(
  repository: GastownRepositoryOption,
  gitlabInstanceUrl?: string
): {
  gitUrl: string;
  defaultBranch: string;
  platformIntegrationId?: string;
} | null {
  if (repository.platform === 'bitbucket') return null;

  const gitUrl =
    repository.platform === 'gitlab'
      ? `${(gitlabInstanceUrl ?? 'https://gitlab.com').replace(/\/+$/, '')}/${repository.fullName}.git`
      : `https://github.com/${repository.fullName}.git`;

  return {
    gitUrl,
    defaultBranch: repository.defaultBranch || 'main',
    ...(repository.platformIntegrationId
      ? { platformIntegrationId: repository.platformIntegrationId }
      : {}),
  };
}

export function GastownRepositorySelector({
  repositories,
  value,
  onValueChange,
  isLoading = false,
  placeholder = 'Select a repository...',
}: {
  repositories: GastownRepositoryOption[];
  value: string;
  onValueChange: (selectionKey: string) => void;
  isLoading?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedRepository = findGastownRepository(repositories, value);
  const duplicateNames = duplicateRepositoryNames(repositories);
  const selectedDiscriminator = selectedRepository
    ? getGastownRepositoryDiscriminator(selectedRepository, duplicateNames)
    : null;
  const groups = groupGastownRepositories(repositories);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-11 w-full sm:h-9" />
        <p className="text-muted-foreground text-xs">Loading repositories...</p>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          role="combobox"
          aria-label="Repository"
          aria-expanded={open}
          className="min-h-11 w-full min-w-0 justify-between gap-2 border-white/10 bg-black/25 px-3 py-1.5 font-normal sm:min-h-9"
          title={selectedRepository?.fullName}
        >
          {selectedRepository ? (
            <GastownRepositoryOptionLabel
              repository={selectedRepository}
              discriminator={selectedDiscriminator}
            />
          ) : (
            <span className="min-w-0 truncate font-mono text-white/40">{placeholder}</span>
          )}
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(32rem,calc(100vw-2rem))] p-0"
        style={{ minWidth: triggerRef.current?.offsetWidth }}
      >
        <Command>
          <CommandInput placeholder="Search repositories..." />
          <CommandEmpty>No repositories match your search.</CommandEmpty>
          <CommandList className="max-h-72">
            {groups.map(group => (
              <CommandGroup key={group.key} heading={group.label}>
                {group.repositories.map(repository => {
                  const selectionKey = gastownRepositoryKey(repository);
                  const discriminator = getGastownRepositoryDiscriminator(
                    repository,
                    duplicateNames
                  );
                  return (
                    <CommandItem
                      key={selectionKey}
                      value={`${repository.fullName} ${repository.platformAccountLogin ?? ''} ${repository.platformIntegrationId ?? ''}`}
                      onSelect={() => {
                        onValueChange(selectionKey);
                        setOpen(false);
                      }}
                      className="min-h-11 min-w-0 gap-2 sm:min-h-9"
                    >
                      {repository.private ? (
                        <Lock className="size-3.5 shrink-0 text-yellow-500" />
                      ) : (
                        <Unlock className="text-muted-foreground size-3.5 shrink-0" />
                      )}
                      <GastownRepositoryOptionLabel
                        repository={repository}
                        discriminator={discriminator}
                      />
                      <Check
                        className={cn(
                          'ml-auto size-4 shrink-0',
                          selectionKey === value ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

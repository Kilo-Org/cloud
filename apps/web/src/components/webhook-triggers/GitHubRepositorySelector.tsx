'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import type { RepositoryOption } from '@/components/shared/RepositoryCombobox';
import { cn } from '@/lib/utils';
import { AlertTriangle, Check, ChevronsUpDown, Lock, Unlock } from 'lucide-react';
import {
  findSelectedRepository,
  groupGitHubRepositories,
  isSelectedRepository,
  repositorySelection,
  shortIntegrationId,
  type GitHubRepositorySelection,
} from './github-repository-selection';

type GitHubRepositorySelectorProps = {
  repositories: RepositoryOption[];
  value: GitHubRepositorySelection;
  onValueChange: (value: GitHubRepositorySelection) => void;
  isLoading?: boolean;
  error?: string;
  repositoryReadOnly?: boolean;
  integrationsPath: string;
};

type GitHubRepositorySelectorListProps = Pick<
  GitHubRepositorySelectorProps,
  'repositories' | 'value' | 'onValueChange'
>;

export function GitHubRepositorySelectorList({
  repositories,
  value,
  onValueChange,
}: GitHubRepositorySelectorListProps) {
  return groupGitHubRepositories(repositories).map(group => (
    <CommandGroup key={group.key} heading={group.label}>
      {group.repositories.map(repository => (
        <CommandItem
          key={`${group.key}:${repository.id}:${repository.fullName}`}
          value={`${repository.fullName} ${repository.platformAccountLogin ?? ''} ${repository.platformIntegrationId ?? ''}`}
          onSelect={() => onValueChange(repositorySelection(repository))}
          className="flex items-center gap-2"
        >
          {repository.private ? (
            <Lock className="size-3.5 text-yellow-500" />
          ) : (
            <Unlock className="text-muted-foreground size-3.5" />
          )}
          <span className="truncate font-mono">{repository.fullName}</span>
          <Check
            className={cn(
              'ml-auto size-4',
              isSelectedRepository(repository, value) ? 'opacity-100' : 'opacity-0'
            )}
          />
        </CommandItem>
      ))}
    </CommandGroup>
  ));
}

export function UnavailablePinnedGitHubInstallation({
  selection,
  integrationsPath,
}: {
  selection: GitHubRepositorySelection;
  integrationsPath: string;
}) {
  const installation = selection.platformAccountLogin
    ? `the ${selection.platformAccountLogin} installation`
    : selection.platformIntegrationId
      ? `installation ${shortIntegrationId(selection.platformIntegrationId)}`
      : 'the saved installation';

  return (
    <Alert variant="warning">
      <AlertTriangle />
      <AlertTitle>Saved GitHub installation unavailable</AlertTitle>
      <AlertDescription>
        <p>
          This trigger is pinned to {installation}, which no longer provides access to{' '}
          <span className="font-mono">{selection.repository}</span>. Restore it or choose another
          installation with access to this repository.
        </p>
        <Link
          href={integrationsPath}
          className="text-link hover:text-link-hover font-medium underline underline-offset-4"
        >
          Review GitHub integrations
        </Link>
      </AlertDescription>
    </Alert>
  );
}

export function GitHubRepositorySelector({
  repositories,
  value,
  onValueChange,
  isLoading,
  error,
  repositoryReadOnly = false,
  integrationsPath,
}: GitHubRepositorySelectorProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const candidates = repositoryReadOnly
    ? repositories.filter(repository => repository.fullName === value.repository)
    : repositories;
  const selectedRepository = findSelectedRepository(repositories, value);
  const pinnedInstallationUnavailable =
    value.platformIntegrationId !== undefined && selectedRepository === undefined;

  if (isLoading) {
    return <Skeleton className="h-9 w-full" />;
  }

  if (error) {
    return (
      <div
        role="alert"
        className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
      >
        GitHub repositories could not be loaded: {error}
      </div>
    );
  }

  const accountLabel =
    selectedRepository?.platformAccountLogin ??
    value.platformAccountLogin ??
    selectedRepository?.fullName.split('/')[0] ??
    'GitHub installation';
  const buttonLabel = repositoryReadOnly
    ? selectedRepository
      ? accountLabel
      : 'Choose another installation'
    : selectedRepository
      ? `${selectedRepository.fullName} · ${accountLabel}`
      : 'Select a repository';

  return (
    <div className="space-y-2">
      {pinnedInstallationUnavailable && (
        <UnavailablePinnedGitHubInstallation
          selection={value}
          integrationsPath={integrationsPath}
        />
      )}
      {candidates.length > 0 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-label={repositoryReadOnly ? 'Select GitHub installation' : 'Select repository'}
              className="w-full justify-between"
            >
              <span className="truncate text-left">{buttonLabel}</span>
              <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="p-0"
            align="start"
            style={{ width: triggerRef.current?.offsetWidth }}
          >
            <Command>
              <CommandInput placeholder="Search GitHub repositories..." />
              <CommandEmpty>No repositories match your search</CommandEmpty>
              <CommandList className="max-h-64 overflow-auto">
                <GitHubRepositorySelectorList
                  repositories={candidates}
                  value={value}
                  onValueChange={selection => {
                    onValueChange(selection);
                    setOpen(false);
                  }}
                />
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      ) : !pinnedInstallationUnavailable ? (
        <div className="border-border bg-muted/50 text-muted-foreground rounded-md border px-3 py-2 text-sm">
          No GitHub repositories are available.{' '}
          <Link
            href={integrationsPath}
            className="text-link hover:text-link-hover underline underline-offset-4"
          >
            Review GitHub integrations
          </Link>
        </div>
      ) : null}
      <p className="text-muted-foreground text-xs">
        {repositoryReadOnly
          ? 'Choose the GitHub App installation used when this trigger runs.'
          : 'Repositories are grouped by the GitHub account where the Kilo App is installed.'}
      </p>
    </div>
  );
}

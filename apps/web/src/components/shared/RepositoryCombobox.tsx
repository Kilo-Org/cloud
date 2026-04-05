'use client';

import { useRef, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { ChevronsUpDown, Check, Lock, Unlock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GitLabLogo } from '@/components/auth/GitLabLogo';

export type RepositoryPlatform = 'github' | 'gitlab';

export type RepositoryOption = {
  id: string | number;
  fullName: string;
  private?: boolean;
  description?: string;
  platform?: RepositoryPlatform;
};

export type RepositoryComboboxProps = {
  label?: string;
  helperText?: string;
  repositories: RepositoryOption[];
  value?: string;
  onValueChange: (value: string) => void;
  isLoading?: boolean;
  error?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  noResultsText?: string;
  emptyStateText?: string;
  loadingText?: string;
  required?: boolean;
  hideLabel?: boolean;
  groupByPlatform?: boolean;
};

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function PlatformIcon({
  platform,
  className,
}: {
  platform?: RepositoryPlatform;
  className?: string;
}) {
  if (platform === 'github') {
    return <GitHubIcon className={className} />;
  }
  if (platform === 'gitlab') {
    return <GitLabLogo className={className} />;
  }
  return null;
}

function RepositoryItem({
  repo,
  value,
  onSelect,
  showPlatformIcon,
}: {
  repo: RepositoryOption;
  value?: string;
  onSelect: (value: string) => void;
  showPlatformIcon?: boolean;
}) {
  return (
    <CommandItem
      key={repo.id}
      value={repo.fullName}
      onSelect={onSelect}
      className="flex items-center gap-2"
    >
      {showPlatformIcon && repo.platform && (
        <PlatformIcon platform={repo.platform} className="size-3.5" />
      )}
      {repo.private ? (
        <Lock className="size-3.5 text-yellow-500" />
      ) : (
        <Unlock className="size-3.5 text-gray-500" />
      )}
      <span className="truncate">{repo.fullName}</span>
      <Check
        className={cn('ml-auto h-4 w-4', repo.fullName === value ? 'opacity-100' : 'opacity-0')}
      />
    </CommandItem>
  );
}

export function RepositoryCombobox({
  label = 'Repository',
  helperText = 'Select the repository you want to use',
  repositories,
  value,
  onValueChange,
  isLoading,
  error,
  placeholder = 'Select a repository',
  searchPlaceholder = 'Search repositories...',
  noResultsText = 'No repositories match your search',
  emptyStateText = 'No repositories available',
  loadingText = 'Loading repositories...',
  required = true,
  hideLabel = false,
  groupByPlatform = false,
}: RepositoryComboboxProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {!hideLabel && (
          <Label>
            {label} {required && <span className="text-red-400">*</span>}
          </Label>
        )}
        <Skeleton className="h-9 w-full" />
        <p className="text-muted-foreground text-xs">{loadingText}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        {!hideLabel && (
          <Label>
            {label} {required && <span className="text-red-400">*</span>}
          </Label>
        )}
        <div className="rounded-md border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm text-red-400">
          Failed to load repositories: {error}
        </div>
        <p className="text-xs text-gray-500">Please check your settings and try again</p>
      </div>
    );
  }

  if (!repositories || repositories.length === 0) {
    return (
      <div className="space-y-2">
        {!hideLabel && (
          <Label>
            {label} {required && <span className="text-red-400">*</span>}
          </Label>
        )}
        <div className="rounded-md border border-gray-600 bg-gray-800/50 px-3 py-2 text-sm text-gray-400">
          {emptyStateText}
        </div>
        <p className="text-muted-foreground text-xs">
          No repositories are available for this selection
        </p>
      </div>
    );
  }

  const selectedRepo = repositories.find(repo => repo.fullName === value);

  const handleSelect = (currentValue: string) => {
    onValueChange(currentValue);
    setOpen(false);
  };

  // Group repositories by platform when groupByPlatform is enabled
  const githubRepos = repositories.filter(r => r.platform === 'github');
  const gitlabRepos = repositories.filter(r => r.platform === 'gitlab');
  const otherRepos = repositories.filter(r => !r.platform);

  const renderGroupedList = () => (
    <>
      {githubRepos.length > 0 && (
        <CommandGroup heading="GitHub">
          {githubRepos.map(repo => (
            <RepositoryItem
              key={repo.id}
              repo={repo}
              value={value}
              onSelect={handleSelect}
              showPlatformIcon={false}
            />
          ))}
        </CommandGroup>
      )}
      {gitlabRepos.length > 0 && (
        <CommandGroup heading="GitLab">
          {gitlabRepos.map(repo => (
            <RepositoryItem
              key={repo.id}
              repo={repo}
              value={value}
              onSelect={handleSelect}
              showPlatformIcon={false}
            />
          ))}
        </CommandGroup>
      )}
      {otherRepos.length > 0 && (
        <CommandGroup heading="Other">
          {otherRepos.map(repo => (
            <RepositoryItem
              key={repo.id}
              repo={repo}
              value={value}
              onSelect={handleSelect}
              showPlatformIcon={false}
            />
          ))}
        </CommandGroup>
      )}
    </>
  );

  const renderFlatList = () => (
    <CommandGroup>
      {repositories.map(repo => (
        <RepositoryItem
          key={repo.id}
          repo={repo}
          value={value}
          onSelect={handleSelect}
          showPlatformIcon={groupByPlatform}
        />
      ))}
    </CommandGroup>
  );

  return (
    <div className="space-y-2">
      {!hideLabel && (
        <Label htmlFor="repository-combobox">
          {label} {required && <span className="text-red-400">*</span>}
        </Label>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id="repository-combobox"
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-mono"
            ref={triggerRef}
          >
            <span className="flex items-center gap-2 truncate">
              {selectedRepo?.platform && groupByPlatform && (
                <PlatformIcon platform={selectedRepo.platform} className="size-3.5" />
              )}
              {selectedRepo ? selectedRepo.fullName : placeholder}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="p-0"
          align="start"
          style={{ width: triggerRef.current?.offsetWidth }}
        >
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandEmpty>{noResultsText}</CommandEmpty>
            <CommandList className="max-h-64 overflow-auto">
              {groupByPlatform ? renderGroupedList() : renderFlatList()}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {helperText && <p className="text-muted-foreground text-xs">{helperText}</p>}
    </div>
  );
}

'use client';

import { useState, type ReactNode } from 'react';
import { GitBranch, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import type { EnvironmentRepository } from '@/hooks/useCloudAgentEnvironments';
import { useEnvironmentRepositoryChoices } from '@/hooks/useEnvironmentRepositoryChoices';
import {
  addRepository,
  removeRepository,
  repositoryKey,
  repositoryName,
} from './environment-repositories';

type RepositoriesProps = {
  organizationId?: string;
  repositories: EnvironmentRepository[];
  onChange: (repositories: EnvironmentRepository[]) => void;
};

/**
 * The repositories of a multi-repository environment. A session in any of them
 * can use the environment, and clones the others beside it.
 */
export function EnvironmentRepositoriesField({
  organizationId,
  repositories,
  onChange,
}: RepositoriesProps) {
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">Repositories</Label>
        <AddRepositoryPicker
          organizationId={organizationId}
          repositories={repositories}
          onChange={onChange}
        >
          <Button type="button" variant="outline" size="sm">
            <Plus className="mr-1.5 size-3.5" />
            Add repository
          </Button>
        </AddRepositoryPicker>
      </div>
      <ul className="space-y-1">
        {repositories.map(repository => (
          <li
            key={repositoryKey(repository)}
            className="bg-input/30 flex min-w-0 items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
          >
            <GitBranch className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={repositoryName(repository)}>
              {repositoryName(repository)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              aria-label={`Remove ${repositoryName(repository)}`}
              disabled={repositories.length <= 1}
              onClick={() => onChange(removeRepository(repositories, repository))}
            >
              <X className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The same repositories as compact chips, for the agent setup composer. */
export function EnvironmentRepositoryChips({
  organizationId,
  repositories,
  onChange,
}: RepositoriesProps) {
  return (
    <ul className="flex flex-wrap items-center gap-1.5" aria-label="Repositories">
      {repositories.map(repository => (
        <li
          key={repositoryKey(repository)}
          className="bg-background/60 flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md border pr-1 pl-2 text-xs"
        >
          <GitBranch className="text-muted-foreground size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate" title={repositoryName(repository)}>
            {repositoryName(repository)}
          </span>
          {repositories.length > 1 && (
            <button
              type="button"
              aria-label={`Remove ${repositoryName(repository)}`}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2"
              onClick={() => onChange(removeRepository(repositories, repository))}
            >
              <X className="size-3" />
            </button>
          )}
        </li>
      ))}
      <li>
        <AddRepositoryPicker
          organizationId={organizationId}
          repositories={repositories}
          onChange={onChange}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-7 gap-1 px-2 text-xs"
          >
            <Plus className="size-3.5" />
            Add repository
          </Button>
        </AddRepositoryPicker>
      </li>
    </ul>
  );
}

function AddRepositoryPicker({
  organizationId,
  repositories,
  onChange,
  children,
}: RepositoriesProps & { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const choices = useEnvironmentRepositoryChoices(organizationId);
  const selected = new Set(repositories.map(repositoryKey));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[320px] max-w-[calc(100vw-2rem)] p-0" align="end">
        <Command>
          <CommandInput placeholder="Search repositories..." />
          <CommandEmpty>No repositories match your search</CommandEmpty>
          <CommandList className="max-h-64 overflow-auto">
            {choices
              .filter(choice => !selected.has(repositoryKey(choice.repository)))
              .map(choice => (
                <CommandItem
                  key={`${choice.platform}:${choice.label}`}
                  value={`${choice.platform}:${choice.label}`}
                  onSelect={() => {
                    onChange(addRepository(repositories, choice.repository));
                    setOpen(false);
                  }}
                >
                  <GitBranch className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="flex-1 truncate" title={choice.label}>
                    {choice.label}
                  </span>
                </CommandItem>
              ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

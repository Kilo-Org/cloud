'use client';

import { useState } from 'react';
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

/**
 * The repositories of a multi-repository environment. A session in any of them
 * can use the environment, and clones the others beside it.
 */
export function EnvironmentRepositoriesField({
  organizationId,
  repositories,
  onChange,
}: {
  organizationId?: string;
  repositories: EnvironmentRepository[];
  onChange: (repositories: EnvironmentRepository[]) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const choices = useEnvironmentRepositoryChoices(organizationId);
  const selected = new Set(repositories.map(repositoryKey));

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">Repositories</Label>
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <Plus className="mr-1.5 size-3.5" />
              Add repository
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[320px] p-0" align="end">
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
                        setPickerOpen(false);
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

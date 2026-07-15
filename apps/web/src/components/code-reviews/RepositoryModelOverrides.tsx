'use client';

import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import {
  getAvailableThinkingEfforts,
  thinkingEffortLabel,
} from '@/lib/code-reviews/core/model-variants';

export type RepositoryModelOverrideValue = {
  repoFullName: string;
  modelSlug: string;
  thinkingEffort: string | null;
};

export type RepositoryOverrideOption = {
  id: number;
  full_name: string;
};

export type RepositoryModelOverridesProps = {
  /** All repositories available from the integration (independent of trigger selection). */
  availableRepositories: RepositoryOverrideOption[];
  models: ModelOption[];
  isLoadingModels: boolean;
  /** Current overrides keyed by repository id. */
  overrides: Map<number, RepositoryModelOverrideValue>;
  /** Model a newly-added repository override starts on. */
  defaultModelSlug: string;
  /** Add or update the override for a repository. */
  onSet: (repositoryId: number, value: RepositoryModelOverrideValue) => void;
  /** Remove the override for a repository (repo reverts to the default model). */
  onRemove: (repositoryId: number) => void;
  disabled?: boolean;
};

/**
 * Per-repository model overrides, add-on-demand. Only repositories with an override
 * are shown as rows; the "Add repository" picker offers the remaining repositories.
 * Overrides are independent of the trigger selection mode (they apply in both "all"
 * and "selected" modes) — removing a row reverts that repo to the default model.
 */
export function RepositoryModelOverrides({
  availableRepositories,
  models,
  isLoadingModels,
  overrides,
  defaultModelSlug,
  onSet,
  onRemove,
  disabled,
}: RepositoryModelOverridesProps) {
  const overrideRows = useMemo(
    () =>
      Array.from(overrides.entries()).map(([id, value]) => ({
        id,
        ...value,
      })),
    [overrides]
  );

  const repositoriesToAdd = useMemo(
    () => availableRepositories.filter(repository => !overrides.has(repository.id)),
    [availableRepositories, overrides]
  );

  return (
    <div className="space-y-3">
      {overrideRows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No per-repository overrides yet. Add a repository to run its reviews on a different model
          than the default.
        </p>
      ) : (
        <div className="border-border divide-border divide-y rounded-md border">
          {overrideRows.map(row => (
            <RepositoryOverrideRowItem
              key={row.id}
              repoFullName={row.repoFullName}
              models={models}
              isLoadingModels={isLoadingModels}
              value={{
                repoFullName: row.repoFullName,
                modelSlug: row.modelSlug,
                thinkingEffort: row.thinkingEffort,
              }}
              onChange={value => onSet(row.id, value)}
              onRemove={() => onRemove(row.id)}
              disabled={disabled}
            />
          ))}
        </div>
      )}

      <AddRepositoryButton
        repositories={repositoriesToAdd}
        disabled={disabled}
        onSelect={repository =>
          onSet(repository.id, {
            repoFullName: repository.full_name,
            modelSlug: defaultModelSlug,
            thinkingEffort: null,
          })
        }
      />
    </div>
  );
}

function RepositoryOverrideRowItem({
  repoFullName,
  models,
  isLoadingModels,
  value,
  onChange,
  onRemove,
  disabled,
}: {
  repoFullName: string;
  models: ModelOption[];
  isLoadingModels: boolean;
  value: RepositoryModelOverrideValue;
  onChange: (value: RepositoryModelOverrideValue) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const availableVariants = useMemo(
    () => getAvailableThinkingEfforts(value.modelSlug),
    [value.modelSlug]
  );

  return (
    <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
      <span className="min-w-0 truncate font-mono text-sm" title={repoFullName}>
        {repoFullName}
      </span>
      <div className="flex items-center gap-2">
        <ModelCombobox
          variant="compact"
          models={models}
          isLoading={isLoadingModels}
          value={value.modelSlug}
          disabled={disabled}
          // Selecting a model resets thinking effort — the prior effort may not exist
          // on the newly chosen model.
          onValueChange={modelSlug => onChange({ ...value, modelSlug, thinkingEffort: null })}
        />
        {availableVariants.length > 0 && (
          <Select
            value={value.thinkingEffort ?? '__default__'}
            onValueChange={variant =>
              onChange({
                ...value,
                thinkingEffort: variant === '__default__' ? null : variant,
              })
            }
            disabled={disabled}
          >
            <SelectTrigger className="h-9 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">Default effort</SelectItem>
              {availableVariants.map(variant => (
                <SelectItem key={variant} value={variant}>
                  {thinkingEffortLabel(variant)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground h-9 px-2"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove model override for ${repoFullName}`}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function AddRepositoryButton({
  repositories,
  onSelect,
  disabled,
}: {
  repositories: RepositoryOverrideOption[];
  onSelect: (repository: RepositoryOverrideOption) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const noneLeft = repositories.length === 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || noneLeft}
          className="gap-1.5"
        >
          <Plus className="h-4 w-4" />
          {noneLeft ? 'All repositories have overrides' : 'Add repository'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-2rem))] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search repositories..." />
          <CommandEmpty>No repositories match your search</CommandEmpty>
          <CommandList className="max-h-64 overflow-auto">
            <CommandGroup>
              {repositories.map(repository => (
                <CommandItem
                  key={repository.id}
                  value={repository.full_name}
                  onSelect={() => {
                    onSelect(repository);
                    setOpen(false);
                  }}
                  className="font-mono"
                >
                  {repository.full_name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

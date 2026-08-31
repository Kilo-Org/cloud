'use client';

import { useMemo, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Lock, Unlock, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import {
  visibleRepositories,
  withVisibleSelected,
  withoutVisibleSelected,
} from './repository-multi-select-selection';

export type RepositoryId = string | number;

export type Repository<TId extends RepositoryId = number> = {
  id: TId;
  name: string;
  full_name: string;
  private: boolean;
  fork?: boolean;
};

export type RepositoryMultiSelectProps<TId extends RepositoryId = number> = {
  repositories: Repository<TId>[];
  selectedIds: TId[];
  onSelectionChange: (selectedIds: TId[]) => void;
  renderRepositoryAccessory?: (repository: Repository<TId>) => React.ReactNode;
};

export function RepositoryMultiSelect<TId extends RepositoryId = number>({
  repositories,
  selectedIds,
  onSelectionChange,
  renderRepositoryAccessory,
}: RepositoryMultiSelectProps<TId>) {
  const [searchQuery, setSearchQuery] = useState('');
  const [hideForks, setHideForks] = useLocalStorage<boolean>('repo-picker:hide-forks', false, {
    initializeWithValue: false,
  });

  const forkCount = useMemo(() => repositories.filter(repo => repo.fork).length, [repositories]);
  const visible = useMemo(
    () => visibleRepositories(repositories, hideForks),
    [repositories, hideForks]
  );

  const filteredRepositories = useMemo(() => {
    if (!searchQuery.trim()) return visible;

    const query = searchQuery.toLowerCase();
    return visible.filter(repo => repo.full_name.toLowerCase().includes(query));
  }, [visible, searchQuery]);

  const handleToggle = (repoId: TId) => {
    const newSelection = selectedIds.includes(repoId)
      ? selectedIds.filter(id => id !== repoId)
      : [...selectedIds, repoId];

    onSelectionChange(newSelection);
  };

  const handleSelectAll = () => {
    onSelectionChange(
      withVisibleSelected(
        selectedIds,
        visible.map(repo => repo.id)
      )
    );
  };

  const handleDeselectAll = () => {
    onSelectionChange(
      withoutVisibleSelected(
        selectedIds,
        visible.map(repo => repo.id)
      )
    );
  };

  const visibleSelectedCount = visible.filter(repo => selectedIds.includes(repo.id)).length;
  const isAllSelected = visible.length > 0 && visibleSelectedCount === visible.length;
  const isNoneSelected = visibleSelectedCount === 0;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
        <Input
          type="text"
          placeholder="Search repositories..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleSelectAll}
          disabled={isAllSelected}
          className="text-xs"
        >
          Select All
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleDeselectAll}
          disabled={isNoneSelected}
          className="text-xs"
        >
          Deselect All
        </Button>
        {forkCount > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <Checkbox
              id="hide-forks"
              checked={hideForks}
              onCheckedChange={checked => setHideForks(checked === true)}
            />
            <label htmlFor="hide-forks" className="text-muted-foreground cursor-pointer text-xs">
              Hide forks
            </label>
          </div>
        )}
      </div>

      <div className="border-border bg-background h-64 overflow-y-auto rounded-md border">
        <div className="space-y-3 p-4">
          {filteredRepositories.length === 0 ? (
            <div className="text-muted-foreground py-8 text-center text-sm">
              {searchQuery ? 'No repositories match your search' : 'No repositories available'}
            </div>
          ) : (
            filteredRepositories.map(repo => {
              const isChecked = selectedIds.includes(repo.id);

              return (
                <div
                  key={repo.id}
                  className={cn(
                    'hover:bg-accent flex items-center gap-3 rounded-md p-2 transition-colors',
                    isChecked && 'bg-accent text-accent-foreground'
                  )}
                >
                  <Checkbox
                    id={`repo-${repo.id}`}
                    checked={isChecked}
                    onCheckedChange={() => handleToggle(repo.id)}
                  />
                  <label
                    htmlFor={`repo-${repo.id}`}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm"
                  >
                    {repo.private ? (
                      <Lock className="text-primary h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <Unlock className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="truncate font-mono">{repo.full_name}</span>
                    {renderRepositoryAccessory?.(repo)}
                  </label>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="text-muted-foreground text-xs">
        {visibleSelectedCount} of {visible.length} repositories selected
        {hideForks && forkCount > 0
          ? ` · ${forkCount} ${forkCount === 1 ? 'fork' : 'forks'} hidden`
          : ''}
      </div>
    </div>
  );
}

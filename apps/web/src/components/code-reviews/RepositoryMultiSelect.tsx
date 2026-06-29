'use client';

import { useMemo, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Lock, Unlock, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export type Repository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
};

export type RepositoryMultiSelectProps = {
  repositories: Repository[];
  selectedIds: number[];
  onSelectionChange: (selectedIds: number[]) => void;
};

export function RepositoryMultiSelect({
  repositories,
  selectedIds,
  onSelectionChange,
}: RepositoryMultiSelectProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredRepositories = useMemo(() => {
    if (!searchQuery.trim()) return repositories;

    const query = searchQuery.toLowerCase();
    return repositories.filter(repo => repo.full_name.toLowerCase().includes(query));
  }, [repositories, searchQuery]);

  const handleToggle = (repoId: number) => {
    const newSelection = selectedIds.includes(repoId)
      ? selectedIds.filter(id => id !== repoId)
      : [...selectedIds, repoId];

    onSelectionChange(newSelection);
  };

  const handleSelectAll = () => {
    onSelectionChange(repositories.map(repo => repo.id));
  };

  const handleDeselectAll = () => {
    onSelectionChange([]);
  };

  const isAllSelected = selectedIds.length === repositories.length && repositories.length > 0;
  const isNoneSelected = selectedIds.length === 0;

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
                    className="flex flex-1 cursor-pointer items-center gap-2 text-sm"
                  >
                    {repo.private ? (
                      <Lock className="text-primary h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <Unlock className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="truncate font-mono">{repo.full_name}</span>
                  </label>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="text-muted-foreground text-xs">
        {selectedIds.length} of {repositories.length} repositories selected
      </div>
    </div>
  );
}

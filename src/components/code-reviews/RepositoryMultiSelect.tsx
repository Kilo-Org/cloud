'use client';

import { useState, useMemo } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Lock, Unlock, Search, Plus, X } from 'lucide-react';
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
  /** Allow manually adding repositories by path (for GitLab where pagination limits results) */
  allowManualAdd?: boolean;
  /** Callback when a repository is manually added */
  onManualAdd?: (repo: Repository) => void;
};

export function RepositoryMultiSelect({
  repositories,
  selectedIds,
  onSelectionChange,
  allowManualAdd = false,
  onManualAdd,
}: RepositoryMultiSelectProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [manualRepoPath, setManualRepoPath] = useState('');
  const [manualRepoId, setManualRepoId] = useState('');
  const [showManualAdd, setShowManualAdd] = useState(false);

  // Filter repositories based on search query
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

  const handleManualAdd = () => {
    if (!manualRepoPath.trim() || !manualRepoId.trim() || !onManualAdd) return;

    // Parse the project ID - must be a valid positive integer
    const projectId = parseInt(manualRepoId.trim(), 10);
    if (isNaN(projectId) || projectId <= 0) {
      return; // Invalid ID
    }

    // Check if this ID already exists in the list
    if (repositories.some(repo => repo.id === projectId)) {
      // Already exists, just clear and close
      setManualRepoPath('');
      setManualRepoId('');
      setShowManualAdd(false);
      return;
    }

    const pathParts = manualRepoPath.trim().split('/');
    const name = pathParts[pathParts.length - 1] || manualRepoPath.trim();

    const newRepo: Repository = {
      id: projectId,
      name,
      full_name: manualRepoPath.trim(),
      private: true, // Assume private by default
    };

    onManualAdd(newRepo);
    setManualRepoPath('');
    setManualRepoId('');
    setShowManualAdd(false);
  };

  return (
    <div className="space-y-3">
      {/* Search Input */}
      <div className="relative">
        <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <Input
          type="text"
          placeholder="Search repositories..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Select All / Deselect All / Add Manual */}
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
        {allowManualAdd && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setShowManualAdd(!showManualAdd)}
            className="text-xs"
          >
            <Plus className="mr-1 h-3 w-3" />
            Add Repository
          </Button>
        )}
      </div>

      {/* Manual Add Input */}
      {allowManualAdd && showManualAdd && (
        <div className="space-y-2 rounded-md border border-blue-500/30 bg-blue-500/10 p-3">
          <p className="text-xs text-blue-200">
            Add a GitLab project manually. You can find the Project ID in GitLab under Settings →
            General.
          </p>
          <div className="flex gap-2">
            <Input
              type="text"
              placeholder="Project ID (e.g., 75510087)"
              value={manualRepoId}
              onChange={e => setManualRepoId(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleManualAdd();
                }
              }}
              className="w-40 text-sm"
            />
            <Input
              type="text"
              placeholder="group/project"
              value={manualRepoPath}
              onChange={e => setManualRepoPath(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleManualAdd();
                }
              }}
              className="flex-1 text-sm"
            />
            <Button
              type="button"
              size="sm"
              onClick={handleManualAdd}
              disabled={!manualRepoPath.trim() || !manualRepoId.trim()}
            >
              Add
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowManualAdd(false);
                setManualRepoPath('');
                setManualRepoId('');
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Repository List */}
      <div className="h-64 overflow-y-auto rounded-md border">
        <div className="space-y-3 p-4">
          {filteredRepositories.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">
              {searchQuery ? 'No repositories match your search' : 'No repositories available'}
            </div>
          ) : (
            filteredRepositories.map(repo => {
              const isChecked = selectedIds.includes(repo.id);

              return (
                <div
                  key={repo.id}
                  className={cn(
                    'flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-gray-800/50',
                    isChecked && 'bg-gray-800/30'
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
                      <Lock className="h-3.5 w-3.5 shrink-0 text-yellow-500" />
                    ) : (
                      <Unlock className="h-3.5 w-3.5 shrink-0 text-gray-500" />
                    )}
                    <span className="truncate font-mono">{repo.full_name}</span>
                  </label>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Selection Count */}
      <div className="text-xs text-gray-400">
        {selectedIds.length} of {repositories.length} repositories selected
      </div>
    </div>
  );
}

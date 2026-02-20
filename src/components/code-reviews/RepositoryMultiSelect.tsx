'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Lock, Unlock, Search, Loader2 } from 'lucide-react';
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
  /** Callback when a repository from API search results is added to the list */
  onAddFromSearch?: (repo: Repository) => void;
  /** Callback to search for repositories via API (for GitLab with 100+ repos) */
  onSearch?: (query: string) => Promise<Repository[]>;
};

/**
 * Custom hook for debouncing a value
 */
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

export function RepositoryMultiSelect({
  repositories,
  selectedIds,
  onSelectionChange,
  onAddFromSearch,
  onSearch,
}: RepositoryMultiSelectProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [apiSearchResults, setApiSearchResults] = useState<Repository[]>([]);

  // Debounce search query for API calls
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  // Filter local repositories based on search query (instant)
  const filteredLocalRepositories = useMemo(() => {
    if (!searchQuery.trim()) return repositories;

    const query = searchQuery.toLowerCase();
    return repositories.filter(repo => repo.full_name.toLowerCase().includes(query));
  }, [repositories, searchQuery]);

  // Perform API search when debounced query changes
  const performApiSearch = useCallback(
    async (query: string) => {
      if (!onSearch || query.length < 2) {
        setApiSearchResults([]);
        return;
      }

      setIsSearching(true);
      try {
        const results = await onSearch(query);
        // Filter out repos that are already in the local list
        const localIds = new Set(repositories.map(r => r.id));
        const newResults = results.filter(r => !localIds.has(r.id));
        setApiSearchResults(newResults);
      } catch (error) {
        console.error('API search failed:', error);
        setApiSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    },
    [onSearch, repositories]
  );

  // Trigger API search when debounced query changes
  useEffect(() => {
    if (debouncedSearchQuery.length >= 2 && onSearch) {
      void performApiSearch(debouncedSearchQuery);
    } else {
      setApiSearchResults([]);
    }
  }, [debouncedSearchQuery, performApiSearch, onSearch]);

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

  // Handle selecting a repo from API search results
  const handleSelectSearchResult = (repo: Repository) => {
    // Add to the repository list via callback if provided
    if (onAddFromSearch) {
      onAddFromSearch(repo);
    }
    // Also select it
    if (!selectedIds.includes(repo.id)) {
      onSelectionChange([...selectedIds, repo.id]);
    }
  };

  const hasApiResults = apiSearchResults.length > 0;
  const showApiSection = onSearch && (isSearching || hasApiResults) && searchQuery.length >= 2;

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
        {isSearching && (
          <Loader2 className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin text-gray-400" />
        )}
      </div>

      {/* Select All / Deselect All */}
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

      {/* Repository List */}
      <div className="h-64 overflow-y-auto rounded-md border">
        <div className="space-y-3 p-4">
          {/* Local Results */}
          {filteredLocalRepositories.length === 0 && !showApiSection ? (
            <div className="py-8 text-center text-sm text-gray-400">
              {searchQuery ? 'No repositories match your search' : 'No repositories available'}
            </div>
          ) : (
            <>
              {filteredLocalRepositories.map(repo => {
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
              })}

              {/* API Search Results Section */}
              {showApiSection && (
                <>
                  <div className="my-3 flex items-center gap-2 border-t border-gray-700 pt-3">
                    <span className="text-xs text-gray-400">
                      {isSearching ? (
                        <span className="flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Searching...
                        </span>
                      ) : hasApiResults ? (
                        `${apiSearchResults.length} additional result${apiSearchResults.length === 1 ? '' : 's'}`
                      ) : (
                        'No additional results'
                      )}
                    </span>
                  </div>

                  {apiSearchResults.map(repo => {
                    const isChecked = selectedIds.includes(repo.id);

                    return (
                      <div
                        key={`api-${repo.id}`}
                        className={cn(
                          'flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-gray-800/50',
                          isChecked && 'bg-gray-800/30'
                        )}
                      >
                        <Checkbox
                          id={`api-repo-${repo.id}`}
                          checked={isChecked}
                          onCheckedChange={() => handleSelectSearchResult(repo)}
                        />
                        <label
                          htmlFor={`api-repo-${repo.id}`}
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
                  })}
                </>
              )}
            </>
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

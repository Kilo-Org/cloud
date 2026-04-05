'use client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ActiveFilter } from '../types';

type ActiveFiltersBarProps = {
  activeFilters: ActiveFilter[];
  onRemoveFilter: (filter: ActiveFilter) => void;
  onClearFilters: () => void;
};

/**
 * Fixed status bar that displays active filters as individual chips with remove buttons.
 *
 * This component shows each active filter as a badge that can be individually
 * removed, along with a button to clear all filters at once. Uses a fixed position
 * at the bottom of the screen to prevent layout shift when filters are added/removed.
 */
export function ActiveFiltersBar({
  activeFilters,
  onRemoveFilter,
  onClearFilters,
}: ActiveFiltersBarProps) {
  const isVisible = activeFilters.length > 0;

  const getFilterLabel = (filter: ActiveFilter): string => {
    const prefix = filter.type === 'include' ? '' : 'Not ';
    const subTypeLabel =
      filter.subType === 'user' ? 'User' : filter.subType === 'project' ? 'Project' : 'Model';
    return `${prefix}${subTypeLabel}: ${filter.value}`;
  };

  return (
    <div
      className={cn(
        'bg-accent/95 fixed bottom-6 left-1/2 z-50 mx-6 w-full max-w-6xl -translate-x-1/2 rounded-lg border shadow-2xl backdrop-blur-sm transition-all duration-300 ease-in-out',
        isVisible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-full opacity-0'
      )}
    >
      <div className="px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="text-muted-foreground shrink-0 text-sm">
              {activeFilters.length} filter{activeFilters.length !== 1 ? 's' : ''} active
            </span>
            <div className="flex min-w-0 flex-1 flex-wrap gap-2">
              {activeFilters.map((filter, index) => (
                <Badge
                  key={`${filter.type}-${filter.subType}-${filter.value}-${index}`}
                  variant="secondary"
                  className="flex items-center gap-1.5 pr-1"
                >
                  <span>{getFilterLabel(filter)}</span>
                  <button
                    onClick={() => onRemoveFilter(filter)}
                    className="rounded-sm p-0.5 transition-colors hover:bg-black/20"
                    aria-label={`Remove ${getFilterLabel(filter)} filter`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onClearFilters} className="shrink-0">
            Clear All
          </Button>
        </div>
      </div>
    </div>
  );
}

'use client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { X } from 'lucide-react';
import type { Dimension, FilterDirection } from './types';
import { DIMENSION_LABELS } from './types';

type ActiveFilter = {
  dimension: Dimension;
  direction: FilterDirection;
  value: string;
};

type ActiveFiltersBarProps = {
  filters: ActiveFilter[];
  onRemove: (filter: ActiveFilter) => void;
  onClearAll: () => void;
  labelFor?: (dimension: Dimension, value: string) => string;
};

export function ActiveFiltersBar({
  filters,
  onRemove,
  onClearAll,
  labelFor,
}: ActiveFiltersBarProps) {
  if (filters.length === 0) return null;
  return (
    <div className="bg-background/95 sticky bottom-0 z-40 flex flex-wrap items-center gap-2 border-t px-4 py-2 backdrop-blur">
      <span className="text-muted-foreground text-xs font-medium">
        {filters.length} {filters.length === 1 ? 'filter' : 'filters'} active:
      </span>
      {filters.map(f => (
        <Badge
          key={`${f.dimension}-${f.direction}-${f.value}`}
          variant={f.direction === 'exclude' ? 'destructive' : 'secondary'}
          className="gap-1"
        >
          <span>
            {f.direction === 'exclude' ? 'Not ' : ''}
            {DIMENSION_LABELS[f.dimension]}:
          </span>
          <span className="max-w-[200px] truncate font-mono">
            {labelFor ? labelFor(f.dimension, f.value) : f.value}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-4 w-4 p-0"
            onClick={() => onRemove(f)}
            aria-label="Remove filter"
          >
            <X className="h-3 w-3" />
          </Button>
        </Badge>
      ))}
      <Button variant="ghost" size="sm" onClick={onClearAll}>
        Clear all
      </Button>
    </div>
  );
}

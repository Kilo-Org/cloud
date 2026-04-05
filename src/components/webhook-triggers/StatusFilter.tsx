'use client';

import { memo } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Status filter options */
const STATUS_OPTIONS = [
  { value: 'all', label: 'All Triggers' },
  { value: 'active', label: 'Active Only' },
  { value: 'inactive', label: 'Inactive Only' },
] as const;

export type StatusFilterValue = (typeof STATUS_OPTIONS)[number]['value'];

type StatusFilterProps = {
  value: StatusFilterValue;
  onChange: (value: StatusFilterValue) => void;
  totalCount: number;
  filteredCount: number;
};

/**
 * Filter dropdown for webhook triggers list.
 * Shows current filter and count of filtered/total triggers.
 */
export const StatusFilter = memo(function StatusFilter({
  value,
  onChange,
  totalCount,
  filteredCount,
}: StatusFilterProps) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <Select value={value} onValueChange={v => onChange(v as StatusFilterValue)}>
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder="Filter by status" />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {totalCount > 0 && (
        <span className="text-muted-foreground text-sm">
          {filteredCount} of {totalCount} trigger
          {totalCount !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  );
});

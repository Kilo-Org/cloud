'use client';

import { Button } from '@/components/ui/button';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';

interface SortableButtonProps<T extends string> {
  field: T;
  children: React.ReactNode;
  onSort: (field: T) => void;
  sortConfig: { field: T; direction: 'asc' | 'desc' } | null;
  className?: string;
}

export function SortableButton<T extends string>({
  field,
  children,
  onSort,
  sortConfig,
  className = '',
}: SortableButtonProps<T>) {
  const getSortIcon = (field: T) => {
    if (!sortConfig || sortConfig.field !== field) {
      return <ArrowUpDown className="ml-2 h-4 w-4" />;
    }
    return sortConfig.direction === 'asc' ? (
      <ArrowUp className="ml-2 h-4 w-4" />
    ) : (
      <ArrowDown className="ml-2 h-4 w-4" />
    );
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onSort(field)}
      className={`h-8 pr-2 pl-0 lg:pr-3 ${sortConfig?.field === field ? 'text-primary font-bold' : ''} ${className}`}
    >
      {children}
      {getSortIcon(field)}
    </Button>
  );
}

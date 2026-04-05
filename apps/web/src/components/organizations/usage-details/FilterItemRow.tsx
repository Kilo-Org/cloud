'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Filter, X, Check } from 'lucide-react';
import {
  type FilterCardItem,
  type OrganizationUsageMetric,
  type ActiveFilter,
  isItemFiltered,
  FormattedValue,
  getProgressColor,
} from './FormattedValue';

type FilterItemRowProps = {
  item: FilterCardItem;
  selectedMetric: OrganizationUsageMetric;
  activeFilters: ActiveFilter[];
  onFilter: (item: FilterCardItem) => void;
  onExclude: (item: FilterCardItem) => void;
  hasIncludeFilters?: boolean;
  className?: string;
};

export function FilterItemRow({
  item,
  selectedMetric,
  activeFilters,
  onFilter,
  onExclude,
  hasIncludeFilters = false,
  className = '',
}: FilterItemRowProps) {
  const [isHovered, setIsHovered] = useState(false);

  const isIncludeFiltered = isItemFiltered(item.label, 'include', activeFilters);
  const isExcludeFiltered = isItemFiltered(item.label, 'exclude', activeFilters);

  // Determine if this item should be disabled/greyed out (ghost mode)
  // Ghost mode applies when:
  // 1. There are include filters and this item is not included, OR
  // 2. This item is excluded, OR
  // 3. This item has a value of 0 (not in filtered data)
  const isDisabled =
    (hasIncludeFilters && !isIncludeFiltered) || isExcludeFiltered || item.value === 0;

  return (
    <div
      className={`flex items-center justify-between rounded-lg py-2 ${className} ${
        isDisabled ? 'opacity-40' : ''
      }`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span
            className={`min-w-0 flex-1 truncate pr-2 text-sm font-medium ${isDisabled ? 'text-gray-500' : 'text-white'}`}
          >
            {item.label}
          </span>
          <div className="flex min-h-[20px] shrink-0 items-center justify-end">
            {isHovered ? (
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant={isIncludeFiltered ? 'default' : 'outline'}
                  className="h-5 px-2 text-xs"
                  onClick={() => onFilter(item)}
                >
                  {isIncludeFiltered ? (
                    <>
                      <Check className="mr-1 h-3 w-3" />
                      Clear
                    </>
                  ) : (
                    <>
                      <Filter className="mr-1 h-3 w-3" />
                      Filter
                    </>
                  )}
                </Button>
                {!hasIncludeFilters && (
                  <Button
                    size="sm"
                    variant={isExcludeFiltered ? 'default' : 'outline'}
                    className={`h-5 px-2 text-xs ${
                      isExcludeFiltered
                        ? 'bg-red-600 text-white hover:bg-red-700'
                        : 'text-red-400 hover:bg-red-950 hover:text-red-300'
                    }`}
                    onClick={() => onExclude(item)}
                  >
                    <X className="mr-1 h-3 w-3" />
                    {isExcludeFiltered ? 'Clear' : 'Exclude'}
                  </Button>
                )}
              </div>
            ) : (
              <span className="text-sm font-semibold whitespace-nowrap text-gray-200">
                <FormattedValue value={item.value} metric={selectedMetric} />
              </span>
            )}
          </div>
        </div>
        <div
          className={`relative h-2 overflow-hidden rounded-full ${isDisabled ? 'bg-gray-800' : 'bg-gray-600'}`}
        >
          <div
            className={`absolute top-0 left-0 h-2 rounded-full transition-all duration-300 ${
              isDisabled ? 'bg-gray-700' : getProgressColor(item.percentage)
            }`}
            style={{ width: `${item.percentage}%` }}
          />
        </div>
      </div>
    </div>
  );
}

'use client';
import { motion, AnimatePresence } from 'motion/react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { FilterItemRow } from './FilterItemRow';
import {
  type FilterCardItem,
  type OrganizationUsageMetric,
  type ActiveFilter,
} from './FormattedValue';

export type { FilterCardItem };

export interface FilterCardProps {
  title: string;
  items: FilterCardItem[];
  selectedMetric: OrganizationUsageMetric;
  activeFilters?: ActiveFilter[];
  onFilter: (item: FilterCardItem) => void;
  onExclude: (item: FilterCardItem) => void;
  onShowAll?: () => void;
  className?: string;
  titleTooltip?: string;
}

export function FilterCard({
  title,
  items,
  selectedMetric,
  activeFilters = [],
  onFilter,
  onExclude,
  onShowAll,
  className = '',
  titleTooltip,
}: FilterCardProps) {
  // Show only first 5 items if there are more than 5 and we have onShowAll callback
  const displayItems = onShowAll && items.length > 5 ? items.slice(0, 5) : items;
  const hasMoreItems = onShowAll && items.length > 5;

  // Check if any include filters are active
  const hasIncludeFilters = activeFilters.some(f => f.type === 'include');

  return (
    <Card className={`${className}`}>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg font-semibold">
          {titleTooltip ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help border-b border-dotted border-gray-500">
                    {title}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{titleTooltip}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            title
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.length === 0 ? (
          <div className="py-4 text-center text-sm text-gray-400">No data available</div>
        ) : (
          <AnimatePresence mode="popLayout">
            {displayItems.map(item => (
              <motion.div
                key={item.label}
                layout
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{
                  layout: { type: 'spring', stiffness: 300, damping: 30 },
                  opacity: { duration: 0.2 },
                  y: { duration: 0.2 },
                }}
              >
                <FilterItemRow
                  item={item}
                  selectedMetric={selectedMetric}
                  activeFilters={activeFilters}
                  onFilter={onFilter}
                  onExclude={onExclude}
                  hasIncludeFilters={hasIncludeFilters}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
        {hasMoreItems && (
          <div className="border-t border-gray-700 pt-2">
            <Button variant="outline" size="sm" onClick={onShowAll} className="w-full text-xs">
              Show All ({items.length})
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

'use client';

import { motion, AnimatePresence } from 'motion/react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { List } from 'lucide-react';
import { FilterItemRow } from './FilterItemRow';
import type {
  FilterCardItem,
  OrganizationUsageMetric,
} from '@/components/organizations/usage-details/FormattedValue';
import type { ActiveFilter } from '@/components/organizations/usage-details/types';

type FilterModalProps = {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  items: FilterCardItem[];
  selectedMetric: OrganizationUsageMetric;
  activeFilters: ActiveFilter[];
  onFilter: (item: FilterCardItem) => void;
  onExclude: (item: FilterCardItem) => void;
};

export function FilterModal({
  isOpen,
  onClose,
  title,
  items,
  selectedMetric,
  activeFilters,
  onFilter,
  onExclude,
}: FilterModalProps) {
  // Check if any include filters are active
  const hasIncludeFilters = activeFilters.some(f => f.type === 'include');

  const handleFilter = (item: FilterCardItem) => {
    onFilter(item);
    onClose(); // Close modal when Filter is clicked
  };

  const handleExclude = (item: FilterCardItem) => {
    onExclude(item);
    // Don't close modal when Exclude is clicked - stays open for multiple exclusions
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="flex h-[80vh] max-h-[80vh] w-full max-w-[600px] flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <List className="h-5 w-5" />
            All {title}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-2">
          {items.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">No data available</div>
          ) : (
            <AnimatePresence mode="popLayout">
              {items.map(item => (
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
                    onFilter={handleFilter}
                    onExclude={handleExclude}
                    hasIncludeFilters={hasIncludeFilters}
                    className="border p-3 transition-colors hover:bg-gray-800"
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        </div>

        <DialogFooter className="flex flex-shrink-0 gap-2">
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

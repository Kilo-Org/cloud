'use client';

import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';

type AuditLogsPaginationProps = {
  hasNext: boolean;
  hasPrevious: boolean;
  isLoading?: boolean;
  onNext: () => void;
  onPrevious: () => void;
  currentPage: number;
  totalEvents?: number;
};

export function AuditLogsPagination({
  hasNext,
  hasPrevious,
  isLoading = false,
  onNext,
  onPrevious,
  currentPage,
  totalEvents,
}: AuditLogsPaginationProps) {
  const startIndex = (currentPage - 1) * 100 + 1;
  const endIndex = Math.min(currentPage * 100, totalEvents || currentPage * 100);

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      {/* Page info */}
      <div className="text-muted-foreground text-sm">
        {totalEvents ? (
          <>
            Showing {startIndex}-{endIndex} of {totalEvents.toLocaleString()} events
          </>
        ) : (
          <>Page {currentPage}</>
        )}
      </div>

      {/* Navigation buttons */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onPrevious}
          disabled={!hasPrevious || isLoading}
          className="flex items-center gap-1"
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </Button>

        <div className="text-muted-foreground mx-2 text-sm">Page {currentPage}</div>

        <Button
          variant="outline"
          size="sm"
          onClick={onNext}
          disabled={!hasNext || isLoading}
          className="flex items-center gap-1"
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// Hook for managing pagination state with audit logs
export function useAuditLogsPagination() {
  const [pageStack, setPageStack] = useState<
    Array<{
      before?: string;
      after?: string;
      pageNumber: number;
    }>
  >([{ pageNumber: 1 }]);

  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const currentPage = pageStack[currentPageIndex];

  const goNext = (oldestTimestamp: string) => {
    // Add new page to stack
    const newPage = {
      before: oldestTimestamp,
      pageNumber: currentPage.pageNumber + 1,
    };

    // Remove any pages after current index (for when user went back and now goes forward)
    const newStack = [...pageStack.slice(0, currentPageIndex + 1), newPage];
    setPageStack(newStack);
    setCurrentPageIndex(newStack.length - 1);
  };

  const goPrevious = () => {
    if (currentPageIndex > 0) {
      setCurrentPageIndex(currentPageIndex - 1);
    }
  };

  const reset = () => {
    setPageStack([{ pageNumber: 1 }]);
    setCurrentPageIndex(0);
  };

  const jumpToDate = (date: string) => {
    // Reset stack and jump to specific date
    const newPage = {
      before: date,
      pageNumber: 1, // We don't know the actual page number when jumping
    };
    setPageStack([newPage]);
    setCurrentPageIndex(0);
  };

  return {
    currentPage,
    currentPageNumber: currentPage.pageNumber,
    hasNext: true, // We'll determine this from the API response
    hasPrevious: currentPageIndex > 0,
    goNext,
    goPrevious,
    reset,
    jumpToDate,
  };
}

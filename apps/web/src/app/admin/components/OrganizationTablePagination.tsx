'use client';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { PageSize, PaginationMetadata } from '@/types/pagination';
import { getPaginationHelpers, PAGE_SIZE_OPTIONS } from '@/types/pagination';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

interface OrganizationTablePaginationProps {
  pagination: PaginationMetadata;
  pageSize: PageSize;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: PageSize) => void;
  isLoading: boolean;
}

export function OrganizationTablePagination({
  pagination,
  pageSize,
  onPageChange,
  onPageSizeChange,
  isLoading,
}: OrganizationTablePaginationProps) {
  const { page, total, totalPages } = pagination;
  const { hasNext, hasPrev } = getPaginationHelpers(pagination);

  const startItem = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between px-2">
      <div className="flex items-center space-x-6 lg:space-x-8">
        <div className="flex items-center space-x-2">
          <p className="text-sm font-medium">Rows per page</p>
          <Select
            value={pageSize.toString()}
            onValueChange={value => onPageSizeChange(parseInt(value) as PageSize)}
            disabled={isLoading}
          >
            <SelectTrigger className="h-8 w-[70px]">
              <SelectValue placeholder={pageSize.toString()} />
            </SelectTrigger>
            <SelectContent side="top">
              {PAGE_SIZE_OPTIONS.map(size => (
                <SelectItem key={size} value={size.toString()}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-center text-sm font-medium whitespace-nowrap">
          Showing {startItem}-{endItem} of {total}
        </div>
      </div>
      <div className="flex items-center space-x-2">
        <div className="flex items-center space-x-2">
          <p className="text-sm font-medium">
            Page {page} of {totalPages}
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            className="hidden h-8 w-8 p-0 lg:flex"
            onClick={() => onPageChange(1)}
            disabled={!hasPrev || isLoading}
          >
            <span className="sr-only">Go to first page</span>
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => onPageChange(page - 1)}
            disabled={!hasPrev || isLoading}
          >
            <span className="sr-only">Go to previous page</span>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => onPageChange(page + 1)}
            disabled={!hasNext || isLoading}
          >
            <span className="sr-only">Go to next page</span>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            className="hidden h-8 w-8 p-0 lg:flex"
            onClick={() => onPageChange(totalPages)}
            disabled={!hasNext || isLoading}
          >
            <span className="sr-only">Go to last page</span>
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

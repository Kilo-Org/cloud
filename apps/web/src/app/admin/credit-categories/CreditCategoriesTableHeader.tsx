'use client';

import { TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { CreditCategorySortableField, CreditCategorySortConfig } from '@/types/admin';
import { SortableButton } from '../components/SortableButton';

interface CreditCategoriesTableHeaderProps {
  sortConfig: CreditCategorySortConfig | null;
  onSort: (field: CreditCategorySortableField) => void;
}

export function CreditCategoriesTableHeader({
  sortConfig,
  onSort,
}: CreditCategoriesTableHeaderProps) {
  return (
    <TableHeader className="bg-muted">
      <TableRow>
        <TableHead>
          <SortableButton field="credit_category" sortConfig={sortConfig} onSort={onSort}>
            Credit Category
          </SortableButton>
        </TableHead>
        <TableHead className="text-center">
          <SortableButton
            field="is_user_selfservicable"
            sortConfig={sortConfig}
            onSort={onSort}
            className="justify-center"
          >
            Self-Service
          </SortableButton>
        </TableHead>
        <TableHead className="text-right">
          <SortableButton
            field="promotion_ends_at"
            sortConfig={sortConfig}
            onSort={onSort}
            className="justify-end"
          >
            Ends At
          </SortableButton>
        </TableHead>
        <TableHead className="text-right">
          <SortableButton
            field="user_count"
            sortConfig={sortConfig}
            onSort={onSort}
            className="justify-end"
          >
            Users
          </SortableButton>
        </TableHead>
        <TableHead className="text-right">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <SortableButton
                    field="blocked_user_count"
                    sortConfig={sortConfig}
                    onSort={onSort}
                    className="justify-end"
                  >
                    Blocked
                  </SortableButton>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>Number of users with this credit category who are currently blocked</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </TableHead>
        <TableHead className="text-right">
          <SortableButton
            field="credit_count"
            sortConfig={sortConfig}
            onSort={onSort}
            className="justify-end"
          >
            Credits
          </SortableButton>
        </TableHead>
        <TableHead className="text-right">
          <SortableButton
            field="total_dollars"
            sortConfig={sortConfig}
            onSort={onSort}
            className="justify-end"
          >
            Dollars
          </SortableButton>
        </TableHead>
        <TableHead className="text-right">
          <SortableButton
            field="user_count_last_week"
            sortConfig={sortConfig}
            onSort={onSort}
            className="justify-end"
          >
            Users (7d)
          </SortableButton>
        </TableHead>
        <TableHead className="text-right">
          <SortableButton
            field="credit_count_last_week"
            sortConfig={sortConfig}
            onSort={onSort}
            className="justify-end"
          >
            Credits (7d)
          </SortableButton>
        </TableHead>
        <TableHead className="text-right">
          <SortableButton
            field="total_dollars_last_week"
            sortConfig={sortConfig}
            onSort={onSort}
            className="justify-end"
          >
            Dollars (7d)
          </SortableButton>
        </TableHead>
        <TableHead className="text-right">
          <SortableButton
            field="first_used_at"
            sortConfig={sortConfig}
            onSort={onSort}
            className="justify-end"
          >
            First Use
          </SortableButton>
        </TableHead>
        <TableHead className="text-right">
          <SortableButton
            field="last_used_at"
            sortConfig={sortConfig}
            onSort={onSort}
            className="justify-end"
          >
            Last Use
          </SortableButton>
        </TableHead>
      </TableRow>
    </TableHeader>
  );
}

'use client';

import { TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { OrganizationSortableField } from '@/types/admin';
import { SortableButton } from './SortableButton';

type OrganizationSortConfig = {
  field: OrganizationSortableField;
  direction: 'asc' | 'desc';
};

interface OrganizationTableHeaderProps {
  sortConfig: OrganizationSortConfig | null;
  onSort: (field: OrganizationSortableField) => void;
  showDeleted?: boolean;
}

export function OrganizationTableHeader({
  sortConfig,
  onSort,
  showDeleted,
}: OrganizationTableHeaderProps) {
  return (
    <TableHeader className="bg-muted">
      <TableRow>
        <TableHead>
          <SortableButton field="name" sortConfig={sortConfig} onSort={onSort}>
            Name
          </SortableButton>
        </TableHead>
        <TableHead>
          <SortableButton field="microdollars_used" sortConfig={sortConfig} onSort={onSort}>
            Usage
          </SortableButton>
        </TableHead>
        <TableHead>
          <SortableButton field="balance" sortConfig={sortConfig} onSort={onSort}>
            Balance
          </SortableButton>
        </TableHead>
        <TableHead>
          <SortableButton field="member_count" sortConfig={sortConfig} onSort={onSort}>
            Users / Seats
          </SortableButton>
        </TableHead>
        <TableHead>Plan</TableHead>
        <TableHead>Stripe Status</TableHead>
        <TableHead>Subscription</TableHead>
        <TableHead>Kilo Pass</TableHead>
        <TableHead>KiloClaw</TableHead>
        <TableHead>Links</TableHead>
        {showDeleted && <TableHead>Deleted</TableHead>}
        <TableHead>Actions</TableHead>
      </TableRow>
    </TableHeader>
  );
}

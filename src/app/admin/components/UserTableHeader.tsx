'use client';

import { TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { SortableField, SortConfig } from '@/types/admin';
import { SortableButton } from './SortableButton';

interface UserTableHeaderProps {
  sortConfig: SortConfig | null;
  onSort: (field: SortableField) => void;
}

export function UserTableHeader({ sortConfig, onSort }: UserTableHeaderProps) {
  return (
    <TableHeader className="bg-muted">
      <TableRow>
        <TableHead style={{ maxWidth: '25em' }}>
          <SortableButton field="google_user_email" sortConfig={sortConfig} onSort={onSort}>
            Account
          </SortableButton>
        </TableHead>
        <TableHead>
          <SortableButton field="created_at" sortConfig={sortConfig} onSort={onSort}>
            Created
          </SortableButton>
        </TableHead>
        <TableHead>
          <SortableButton field="updated_at" sortConfig={sortConfig} onSort={onSort}>
            Updated
          </SortableButton>
        </TableHead>
        <TableHead>
          <SortableButton
            field="total_microdollars_acquired"
            sortConfig={sortConfig}
            onSort={onSort}
          >
            Acquired
          </SortableButton>
        </TableHead>
        <TableHead>
          <SortableButton field="microdollars_used" sortConfig={sortConfig} onSort={onSort}>
            Usage
          </SortableButton>
        </TableHead>
        <TableHead>Balance</TableHead>
        <TableHead>Notes</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>Paid</TableHead>
        <TableHead>Auto Top-Up</TableHead>
        <TableHead>External Links</TableHead>
      </TableRow>
    </TableHeader>
  );
}

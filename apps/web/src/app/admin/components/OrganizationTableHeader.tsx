'use client';

import { TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { OrganizationSortableField } from '@/types/admin';
import { SortableButton } from './SortableButton';

export type TableVariant = 'entitlements' | 'usage';

type OrganizationSortConfig = {
  field: OrganizationSortableField;
  direction: 'asc' | 'desc';
};

interface OrganizationTableHeaderProps {
  variant: TableVariant;
  sortConfig: OrganizationSortConfig | null;
  onSort: (field: OrganizationSortableField) => void;
  showDeleted?: boolean;
  showStripeStatus?: boolean;
  showTrialEndDate?: boolean;
}

export function OrganizationTableHeader({
  variant,
  sortConfig,
  onSort,
  showDeleted,
  showStripeStatus = true,
  showTrialEndDate = false,
}: OrganizationTableHeaderProps) {
  if (variant === 'entitlements') {
    return (
      <TableHeader className="bg-muted">
        <TableRow>
          <TableHead>
            <SortableButton field="name" sortConfig={sortConfig} onSort={onSort}>
              Name
            </SortableButton>
          </TableHead>
          <TableHead>
            <SortableButton field="plan" sortConfig={sortConfig} onSort={onSort}>
              Plan
            </SortableButton>
          </TableHead>
          <TableHead>
            <SortableButton field="kilo_pass_tier" sortConfig={sortConfig} onSort={onSort}>
              Kilo Pass
            </SortableButton>
          </TableHead>
          {showStripeStatus && (
            <TableHead>
              <SortableButton field="latest_stripe_status" sortConfig={sortConfig} onSort={onSort}>
                Stripe Status
              </SortableButton>
            </TableHead>
          )}
          <TableHead>
            <SortableButton field="subscription_amount_usd" sortConfig={sortConfig} onSort={onSort}>
              Subscription
            </SortableButton>
          </TableHead>
          <TableHead>Links</TableHead>
          {showDeleted && <TableHead>Deleted</TableHead>}
        </TableRow>
      </TableHeader>
    );
  }

  return (
    <TableHeader className="bg-muted">
      <TableRow>
        <TableHead>
          <SortableButton field="name" sortConfig={sortConfig} onSort={onSort}>
            Name
          </SortableButton>
        </TableHead>
        {showTrialEndDate && <TableHead>Trial End</TableHead>}
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
        <TableHead>Tier Features</TableHead>
        <TableHead>Integrations</TableHead>
        <TableHead>KiloClaw</TableHead>
        <TableHead>Auto Top-Up</TableHead>
        <TableHead>Links</TableHead>
        {showDeleted && <TableHead>Deleted</TableHead>}
      </TableRow>
    </TableHeader>
  );
}

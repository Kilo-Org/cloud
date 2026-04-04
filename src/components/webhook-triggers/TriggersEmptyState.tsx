'use client';

import { memo } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Webhook, Plus } from 'lucide-react';
import type { StatusFilterValue } from './StatusFilter';

type TriggersEmptyStateProps = {
  /** Whether there are any triggers at all (vs filtered to zero) */
  hasAnyTriggers: boolean;
  /** Current filter value (for filtered empty state message) */
  statusFilter: StatusFilterValue;
  /** Callback to clear the filter */
  onClearFilter: () => void;
  /** URL to create a new trigger */
  createUrl: string;
};

/**
 * Empty state component for webhook triggers list.
 * Shows different content for no triggers vs filtered to zero.
 */
export const TriggersEmptyState = memo(function TriggersEmptyState({
  hasAnyTriggers,
  statusFilter,
  onClearFilter,
  createUrl,
}: TriggersEmptyStateProps) {
  // Filtered empty state - triggers exist but none match filter
  if (hasAnyTriggers) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <p className="text-muted-foreground">
          No {statusFilter === 'active' ? 'active' : 'inactive'} triggers found.
        </p>
        <Button variant="link" onClick={onClearFilter} className="mt-2">
          Show all triggers
        </Button>
      </div>
    );
  }

  // True empty state - no triggers at all
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
      <Webhook className="text-muted-foreground h-12 w-12" />
      <h3 className="mt-4 text-lg font-semibold">No triggers yet</h3>
      <p className="text-muted-foreground mt-1 max-w-md text-center">
        Create your first trigger to automatically start cloud agent sessions via webhooks or on a
        recurring schedule.
      </p>
      <Button asChild className="mt-4">
        <Link href={createUrl}>
          <Plus className="mr-2 h-4 w-4" />
          Create your first trigger
        </Link>
      </Button>
    </div>
  );
});

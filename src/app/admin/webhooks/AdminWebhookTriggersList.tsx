'use client';

import { useMemo, useState, useCallback } from 'react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  StatusFilter,
  TriggersTable,
  TriggersLoadingState,
  TriggersErrorState,
  type StatusFilterValue,
} from '@/components/webhook-triggers';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

type AdminWebhookTriggersListProps = {
  label: string;
  backHref: string;
  detailBasePath: string;
} & (
  | { userId: string; organizationId?: undefined }
  | { organizationId: string; userId?: undefined }
);

function resolveAdminScope(
  props: Pick<AdminWebhookTriggersListProps, 'userId' | 'organizationId'>
) {
  if (props.organizationId) {
    return { scope: 'organization', organizationId: props.organizationId } as const;
  }
  // The union type guarantees exactly one of userId/organizationId is present,
  // but TS can't narrow the else branch from a truthiness check on an optional
  // field. The runtime check ensures we never send an empty string.
  const userId = props.userId;
  if (!userId) {
    throw new Error('AdminWebhookTriggersList requires userId or organizationId');
  }
  return { scope: 'user', userId } as const;
}

export function AdminWebhookTriggersList(props: AdminWebhookTriggersListProps) {
  const { label, backHref, detailBasePath } = props;
  const trpc = useTRPC();
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('all');
  const [copiedTriggerId, setCopiedTriggerId] = useState<string | null>(null);

  const adminScope = resolveAdminScope(props);

  const { data, isLoading, isError, error, refetch } = useQuery(
    trpc.admin.webhookTriggers.list.queryOptions(adminScope)
  );

  const triggers = useMemo(() => data ?? [], [data]);

  const filteredTriggers = useMemo(() => {
    switch (statusFilter) {
      case 'active':
        return triggers.filter(trigger => trigger.isActive);
      case 'inactive':
        return triggers.filter(trigger => !trigger.isActive);
      default:
        return triggers;
    }
  }, [triggers, statusFilter]);

  const handleCopyUrl = useCallback(
    async (triggerId: string) => {
      const trigger = triggers.find(t => t.triggerId === triggerId);
      if (!trigger) {
        toast.error('Trigger not found');
        return;
      }

      try {
        await navigator.clipboard.writeText(trigger.inboundUrl);
        setCopiedTriggerId(triggerId);
        toast.success('Webhook URL copied to clipboard');
        setTimeout(() => setCopiedTriggerId(null), 2000);
      } catch {
        toast.error('Failed to copy URL');
      }
    },
    [triggers]
  );

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href={backHref}>Back</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>Webhook Triggers</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-6">
        <div>
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-8 w-8" />
            <h1 className="text-3xl font-bold">Webhook Triggers</h1>
          </div>
          <p className="text-muted-foreground mt-2">Read-only view for {label}.</p>
        </div>

        <StatusFilter
          value={statusFilter}
          onChange={setStatusFilter}
          totalCount={triggers.length}
          filteredCount={filteredTriggers.length}
        />

        {isLoading && <TriggersLoadingState />}

        {isError && <TriggersErrorState error={error} onRetry={refetch} />}

        {!isLoading && !isError && filteredTriggers.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
            <p className="text-muted-foreground">
              {triggers.length > 0
                ? `No ${statusFilter === 'active' ? 'active' : 'inactive'} triggers found.`
                : 'No webhook triggers found.'}
            </p>
            {triggers.length > 0 && (
              <Button variant="link" size="sm" onClick={() => setStatusFilter('all')}>
                Show all triggers
              </Button>
            )}
          </div>
        )}

        {!isLoading && !isError && filteredTriggers.length > 0 && (
          <TriggersTable
            triggers={filteredTriggers}
            onCopyUrl={handleCopyUrl}
            copiedTriggerId={copiedTriggerId}
            getEditUrl={triggerId => `${detailBasePath}/${triggerId}`}
            showDelete={false}
            showEdit
            editLabel="View Details"
          />
        )}
      </div>
    </AdminPage>
  );
}

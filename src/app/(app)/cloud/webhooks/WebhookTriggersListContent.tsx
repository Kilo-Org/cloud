'use client';

import { useState, useCallback, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { getWebhookRoutes } from '@/lib/webhook-routes';
import {
  useWebhookTriggers,
  useGitHubIntegration,
  WebhookTriggersHeader,
  StatusFilter,
  TriggersTable,
  TriggersEmptyState,
  TriggersLoadingState,
  TriggersErrorState,
  GitHubIntegrationRequired,
  DeleteTriggerDialog,
  type StatusFilterValue,
  type DeleteTarget,
} from '@/components/webhook-triggers';

/** Build the inbound webhook URL for a trigger */
function buildWebhookUrl(userId: string, triggerId: string): string {
  return `https://hooks.kilosessions.ai/inbound/user/${userId}/${triggerId}`;
}

type WebhookTriggersListContentProps = {
  organizationId?: string;
};

export function WebhookTriggersListContent({ organizationId }: WebhookTriggersListContentProps) {
  const { data: session } = useSession();

  // State
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('all');
  const [copiedTriggerId, setCopiedTriggerId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  // Routes
  const routes = getWebhookRoutes(organizationId);
  const integrationsPath = organizationId
    ? `/organizations/${organizationId}/integrations`
    : '/integrations';

  // Data fetching
  const { isIntegrationMissing, errorMessage } = useGitHubIntegration(organizationId);
  const { triggers, isLoading, isError, error, refetch, deleteTrigger, isDeleting } =
    useWebhookTriggers(organizationId);

  // Filter triggers based on status
  const filteredTriggers = useMemo(() => {
    switch (statusFilter) {
      case 'active':
        return triggers.filter(t => t.isActive);
      case 'inactive':
        return triggers.filter(t => !t.isActive);
      default:
        return triggers;
    }
  }, [triggers, statusFilter]);

  // Copy webhook URL to clipboard
  const handleCopyUrl = useCallback(
    async (triggerId: string) => {
      const userId = session?.user?.id;
      if (!userId) {
        toast.error('User ID not available');
        return;
      }

      const url = buildWebhookUrl(userId, triggerId);
      try {
        await navigator.clipboard.writeText(url);
        setCopiedTriggerId(triggerId);
        toast.success('Webhook URL copied to clipboard');
        setTimeout(() => setCopiedTriggerId(null), 2000);
      } catch {
        toast.error('Failed to copy URL');
      }
    },
    [session?.user?.id]
  );

  // Open delete confirmation dialog
  const handleDeleteClick = useCallback((triggerId: string, githubRepo: string) => {
    setDeleteTarget({ triggerId, githubRepo });
  }, []);

  // Confirm deletion
  const handleConfirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    deleteTrigger(deleteTarget.triggerId);
    setDeleteTarget(null);
  }, [deleteTarget, deleteTrigger]);

  // GitHub integration missing - show setup prompt
  if (isIntegrationMissing) {
    return (
      <GitHubIntegrationRequired errorMessage={errorMessage} integrationsPath={integrationsPath} />
    );
  }

  return (
    <>
      {/* Header */}
      <WebhookTriggersHeader createUrl={routes.create} />

      {/* Filter */}
      <StatusFilter
        value={statusFilter}
        onChange={setStatusFilter}
        totalCount={triggers.length}
        filteredCount={filteredTriggers.length}
      />

      {/* Loading State */}
      {isLoading && <TriggersLoadingState />}

      {/* Error State */}
      {isError && <TriggersErrorState error={error} onRetry={refetch} />}

      {/* Empty State */}
      {!isLoading && !isError && filteredTriggers.length === 0 && (
        <TriggersEmptyState
          hasAnyTriggers={triggers.length > 0}
          statusFilter={statusFilter}
          onClearFilter={() => setStatusFilter('all')}
          createUrl={routes.create}
        />
      )}

      {/* Triggers Table */}
      {!isLoading && !isError && filteredTriggers.length > 0 && (
        <TriggersTable
          triggers={filteredTriggers}
          onCopyUrl={handleCopyUrl}
          onDelete={handleDeleteClick}
          copiedTriggerId={copiedTriggerId}
          getEditUrl={routes.edit}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <DeleteTriggerDialog
        open={!!deleteTarget}
        trigger={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
        isDeleting={isDeleting}
      />
    </>
  );
}

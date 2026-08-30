'use client';

import { useState, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { getWebhookRoutes } from '@/lib/webhook-routes';
import {
  useWebhookTriggers,
  useInvokeWebhookTrigger,
  useGitHubIntegration,
  WebhookTriggersHeader,
  StatusFilter,
  TriggersTable,
  TriggersEmptyState,
  TriggersLoadingState,
  TriggersErrorState,
  GitHubIntegrationRequired,
  DeleteTriggerDialog,
  InvokeTriggerDialog,
  type StatusFilterValue,
  type DeleteTarget,
} from '@/components/webhook-triggers';

type WebhookTriggersListContentProps = {
  organizationId?: string;
};

export function WebhookTriggersListContent({ organizationId }: WebhookTriggersListContentProps) {
  // State
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('all');
  const [copiedTriggerId, setCopiedTriggerId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [invokeTargetId, setInvokeTargetId] = useState<string | null>(null);

  // Routes
  const routes = getWebhookRoutes(organizationId);
  const integrationsPath = organizationId
    ? `/organizations/${organizationId}/integrations`
    : '/integrations';

  // Data fetching
  const { isIntegrationMissing, errorMessage } = useGitHubIntegration(organizationId);
  const { triggers, isLoading, isError, error, refetch, deleteTrigger, isDeleting } =
    useWebhookTriggers(organizationId);
  const { invokeTrigger, isInvoking, invokingTriggerId } = useInvokeWebhookTrigger(organizationId);

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

  const invokeTarget = useMemo(
    () => triggers.find(trigger => trigger.triggerId === invokeTargetId),
    [invokeTargetId, triggers]
  );
  const canInvokeTarget =
    !isDeleting && invokeTarget?.activationMode === 'scheduled' && invokeTarget.isActive === true;

  const handleConfirmInvoke = useCallback(async () => {
    if (!invokeTarget || !canInvokeTarget || isInvoking) return false;

    return (await invokeTrigger(invokeTarget.triggerId)) !== undefined;
  }, [canInvokeTarget, invokeTarget, invokeTrigger, isInvoking]);

  return (
    <>
      {/* Header */}
      <WebhookTriggersHeader createUrl={routes.create} />

      {/* GitHub integration missing - show non-blocking banner */}
      {isIntegrationMissing && (
        <div className="mb-4">
          <GitHubIntegrationRequired
            errorMessage={errorMessage}
            integrationsPath={integrationsPath}
          />
        </div>
      )}

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
          triggers={filteredTriggers.map(t => ({
            ...t,
            activationMode: t.activationMode === 'scheduled' ? 'scheduled' : 'webhook',
          }))}
          onCopyUrl={handleCopyUrl}
          onDelete={handleDeleteClick}
          copiedTriggerId={copiedTriggerId}
          getEditUrl={routes.edit}
          onInvoke={setInvokeTargetId}
          isInvoking={isInvoking}
          invokingTriggerId={invokingTriggerId}
          isInvokeDisabled={isDeleting}
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
      <InvokeTriggerDialog
        open={invokeTargetId !== null}
        triggerId={invokeTargetId}
        isInvokable={canInvokeTarget}
        isInvoking={isInvoking}
        onClose={() => setInvokeTargetId(null)}
        onConfirm={handleConfirmInvoke}
      />
    </>
  );
}

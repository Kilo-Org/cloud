'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Send, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { useTRPC } from '@/lib/trpc/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { DataExportDetail } from '../data-export-types';
import {
  recoveryConfirmationMatches,
  redispatchToastCopy,
  resetRetryDialogAfterSuccess,
  resolveRecoveryActionGate,
  retryToastCopy,
  type RecoveryActionKey,
} from './data-export-recovery';
import {
  ExportIdConfirmationField,
  PurgeConsequences,
  RecoveryActionItem,
  RecoveryErrorAlert,
  RedispatchConsequences,
  RetryConsequences,
} from './DataExportRecoveryParts';

type RecoveryMutationResult = {
  dispatch: 'sent' | 'pending';
  generation: number;
};

export function DataExportRecoveryCard({ detail }: { detail: DataExportDetail }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();

  const [openAction, setOpenAction] = useState<RecoveryActionKey | null>(null);
  const [purgeConfirm, setPurgeConfirm] = useState('');
  const [retryConfirm, setRetryConfirm] = useState('');

  const redispatchMutation = useMutation(
    trpc.admin.userDataExports.redispatch.mutationOptions({
      onSuccess: async (result: RecoveryMutationResult) => {
        const copy = redispatchToastCopy(result);
        toast[copy.kind](copy.title, { description: copy.description });
        setOpenAction(null);
        await Promise.all([
          queryClient.invalidateQueries(
            trpc.admin.userDataExports.detail.queryFilter({ exportId: detail.id })
          ),
          queryClient.invalidateQueries(trpc.admin.userDataExports.list.queryFilter()),
          queryClient.invalidateQueries(trpc.admin.userDataExports.summary.queryFilter()),
        ]);
      },
    })
  );

  const purgeMutation = useMutation(
    trpc.admin.userDataExports.cancelAndPurge.mutationOptions({
      onSuccess: async () => {
        queryClient.removeQueries(
          trpc.admin.userDataExports.detail.queryFilter({ exportId: detail.id })
        );
        await Promise.all([
          queryClient.invalidateQueries(trpc.admin.userDataExports.list.queryFilter()),
          queryClient.invalidateQueries(trpc.admin.userDataExports.summary.queryFilter()),
        ]);
        toast.success('Export canceled and purge queued', {
          description:
            'Artifact and multipart cleanup is queued. The user can request a new export immediately.',
        });
        router.replace('/admin/data-exports');
      },
    })
  );

  const retryMutation = useMutation(
    trpc.admin.userDataExports.cancelAndRetry.mutationOptions({
      onSuccess: async (result: RecoveryMutationResult & { replacementExportId: string }) => {
        resetRetryDialogAfterSuccess({
          close: () => setOpenAction(null),
          clearConfirmation: () => setRetryConfirm(''),
        });
        queryClient.removeQueries(
          trpc.admin.userDataExports.detail.queryFilter({ exportId: detail.id })
        );
        await Promise.all([
          queryClient.invalidateQueries(trpc.admin.userDataExports.list.queryFilter()),
          queryClient.invalidateQueries(trpc.admin.userDataExports.summary.queryFilter()),
        ]);
        const copy = retryToastCopy(result);
        toast[copy.kind](copy.title, { description: copy.description });
        router.replace(`/admin/data-exports/${encodeURIComponent(result.replacementExportId)}`);
      },
    })
  );

  const anyPending =
    redispatchMutation.isPending || purgeMutation.isPending || retryMutation.isPending;

  // User-initiated close only (blocked while pending). Resets stale mutation
  // errors and typed confirmation so a reopened dialog starts clean; errors
  // keep the dialog open and never reach this path.
  const closeDialog = (action: RecoveryActionKey) => {
    setOpenAction(current => (current === action ? null : current));
    if (action === 'redispatch') redispatchMutation.reset();
    if (action === 'cancelAndPurge') {
      setPurgeConfirm('');
      purgeMutation.reset();
    }
    if (action === 'cancelAndRetry') {
      setRetryConfirm('');
      retryMutation.reset();
    }
  };

  const gates = {
    redispatch: resolveRecoveryActionGate(detail.actions.redispatch),
    cancelAndPurge: resolveRecoveryActionGate(detail.actions.cancelAndPurge),
    cancelAndRetry: resolveRecoveryActionGate(detail.actions.cancelAndRetry),
  };

  const mutationInput = () => ({
    exportId: detail.id,
    expectedGeneration: detail.dispatchGeneration,
  });

  return (
    <Card aria-busy={anyPending}>
      <CardHeader>
        <CardTitle>Manual intervention</CardTitle>
        <CardDescription>
          Recovery actions for stuck or broken exports. Every action is re-validated on the server
          against this export&apos;s current dispatch generation; the availability below is only a
          hint, not a guarantee.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          <RecoveryActionItem
            title="Redispatch"
            description="Restart the full export with a new fenced generation when the worker lost it."
            actionLabel="Redispatch export"
            pendingLabel="Redispatching…"
            icon={<Send />}
            variant="outline"
            gate={gates.redispatch}
            isPending={redispatchMutation.isPending}
            anyPending={anyPending}
            onSelect={() => setOpenAction('redispatch')}
          />
          <RecoveryActionItem
            title="Cancel and purge"
            description="Delete the export and queue artifact cleanup without a replacement."
            actionLabel="Cancel and purge export"
            pendingLabel="Purging…"
            icon={<Trash2 />}
            variant="destructive"
            gate={gates.cancelAndPurge}
            isPending={purgeMutation.isPending}
            anyPending={anyPending}
            onSelect={() => setOpenAction('cancelAndPurge')}
          />
          <RecoveryActionItem
            title="Cancel and retry"
            description="Replace the export with a fresh one from the same snapshot."
            actionLabel="Cancel and retry export"
            pendingLabel="Retrying…"
            icon={<RotateCcw />}
            variant="outline"
            gate={gates.cancelAndRetry}
            isPending={retryMutation.isPending}
            anyPending={anyPending}
            onSelect={() => setOpenAction('cancelAndRetry')}
          />
        </ul>
      </CardContent>

      {/* AlertDialog wraps Radix Dialog, which fires onOpenChange for both Escape
          and overlay clicks. While a mutation is in flight, onEscapeKeyDown /
          onPointerDownOutside guards prevent Radix from processing the event, and
          the onOpenChange wrapper blocks our own state flip. AlertDialogAction is
          a plain Button (no DialogClose), so dialogs close via setOpenAction in
          the mutation's onSuccess. Errors keep the dialog open and preserve any
          typed confirmation. */}
      <AlertDialog
        open={openAction === 'redispatch'}
        onOpenChange={open => {
          if (!open && !redispatchMutation.isPending) closeDialog('redispatch');
        }}
      >
        <AlertDialogContent
          aria-busy={redispatchMutation.isPending}
          onEscapeKeyDown={event => {
            if (redispatchMutation.isPending) event.preventDefault();
          }}
          onPointerDownOutside={event => {
            if (redispatchMutation.isPending) event.preventDefault();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Redispatch this export?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <RedispatchConsequences />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {redispatchMutation.isError ? (
            <RecoveryErrorAlert
              title="Redispatch failed"
              message={redispatchMutation.error.message}
            />
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={redispatchMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={gates.redispatch.disabled || redispatchMutation.isPending}
              onClick={() => redispatchMutation.mutate(mutationInput())}
            >
              {redispatchMutation.isPending ? 'Redispatching…' : 'Redispatch export'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={openAction === 'cancelAndPurge'}
        onOpenChange={open => {
          if (!open && !purgeMutation.isPending) closeDialog('cancelAndPurge');
        }}
      >
        <AlertDialogContent
          aria-busy={purgeMutation.isPending}
          onEscapeKeyDown={event => {
            if (purgeMutation.isPending) event.preventDefault();
          }}
          onPointerDownOutside={event => {
            if (purgeMutation.isPending) event.preventDefault();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel and purge this export?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <PurgeConsequences />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ExportIdConfirmationField
            id="purge-confirm-export-id"
            exportId={detail.id}
            value={purgeConfirm}
            disabled={purgeMutation.isPending}
            onChange={setPurgeConfirm}
          />
          {purgeMutation.isError ? (
            <RecoveryErrorAlert title="Purge failed" message={purgeMutation.error.message} />
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={purgeMutation.isPending}>Keep export</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={
                gates.cancelAndPurge.disabled ||
                purgeMutation.isPending ||
                !recoveryConfirmationMatches(purgeConfirm, detail.id)
              }
              onClick={() => purgeMutation.mutate(mutationInput())}
            >
              {purgeMutation.isPending ? 'Purging…' : 'Purge export'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={openAction === 'cancelAndRetry'}
        onOpenChange={open => {
          if (!open && !retryMutation.isPending) closeDialog('cancelAndRetry');
        }}
      >
        <AlertDialogContent
          aria-busy={retryMutation.isPending}
          onEscapeKeyDown={event => {
            if (retryMutation.isPending) event.preventDefault();
          }}
          onPointerDownOutside={event => {
            if (retryMutation.isPending) event.preventDefault();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel and retry this export?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <RetryConsequences />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ExportIdConfirmationField
            id="retry-confirm-export-id"
            exportId={detail.id}
            value={retryConfirm}
            disabled={retryMutation.isPending}
            onChange={setRetryConfirm}
          />
          {retryMutation.isError ? (
            <RecoveryErrorAlert title="Retry failed" message={retryMutation.error.message} />
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={retryMutation.isPending}>Keep export</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={
                gates.cancelAndRetry.disabled ||
                retryMutation.isPending ||
                !recoveryConfirmationMatches(retryConfirm, detail.id)
              }
              onClick={() => retryMutation.mutate(mutationInput())}
            >
              {retryMutation.isPending ? 'Retrying…' : 'Cancel and retry'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

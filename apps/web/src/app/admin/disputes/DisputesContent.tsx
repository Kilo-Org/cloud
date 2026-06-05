'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { AlertTriangle, ExternalLink, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import type { RootRouter } from '@/routers/root-router';
import { useTRPC } from '@/lib/trpc/utils';
import { formatCents } from '@/lib/utils';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const PAGE_SIZE = 25;
const PROCESSING_RETRY_DELAY_MS = 5 * 60 * 1000;

type RouterOutputs = inferRouterOutputs<RootRouter>;
export type DisputeRow = RouterOutputs['admin']['disputes']['list']['rows'][number];
type DisputeStatusFilter =
  | 'all'
  | 'needs_action'
  | 'processing'
  | 'accepted'
  | 'acceptance_failed'
  | 'enforcement_failed'
  | 'review_required'
  | 'closed';
type OwnerFilter = 'all' | 'personal' | 'organization' | 'ambiguous' | 'unmatched';

const statusOptions: Array<{ value: DisputeStatusFilter; label: string }> = [
  { value: 'needs_action', label: 'Needs action' },
  { value: 'processing', label: 'Processing' },
  { value: 'enforcement_failed', label: 'Enforcement failed' },
  { value: 'acceptance_failed', label: 'Acceptance failed' },
  { value: 'review_required', label: 'Review required' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All statuses' },
];

const ownerOptions: Array<{ value: OwnerFilter; label: string }> = [
  { value: 'all', label: 'All owners' },
  { value: 'personal', label: 'Personal' },
  { value: 'organization', label: 'Organization' },
  { value: 'ambiguous', label: 'Ambiguous' },
  { value: 'unmatched', label: 'Unmatched' },
];

export function DisputesContent() {
  const trpc = useTRPC();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<DisputeStatusFilter>('needs_action');
  const [ownerClassification, setOwnerClassification] = useState<OwnerFilter>('all');
  const [selectedCase, setSelectedCase] = useState<DisputeRow | null>(null);
  const [confirmationText, setConfirmationText] = useState('');
  const casesQuery = useQuery(
    trpc.admin.disputes.list.queryOptions({
      page,
      limit: PAGE_SIZE,
      status,
      ownerClassification,
    })
  );
  const acceptMutation = useMutation(
    trpc.admin.disputes.accept.mutationOptions({
      onSuccess: result => {
        if (result.status === 'enforcement_failed') {
          toast.warning('Stripe dispute accepted, but local enforcement needs review.');
        } else {
          toast.success('Stripe dispute accepted and enforcement completed.');
        }
        setSelectedCase(null);
        setConfirmationText('');
        void casesQuery.refetch();
      },
      onError: error => toast.error(error.message || 'Dispute acceptance failed'),
    })
  );

  const rows = casesQuery.data?.rows ?? [];
  const pagination = casesQuery.data?.pagination;
  const selectedCaseNeedsTypedConfirm = Boolean(
    selectedCase?.failureContext ||
    selectedCase?.status === 'enforcement_failed' ||
    selectedCase?.status === 'processing'
  );
  const canConfirmSelectedCase =
    !selectedCaseNeedsTypedConfirm || confirmationText === selectedCase?.stripeDisputeId;

  function updateStatus(nextStatus: DisputeStatusFilter) {
    setStatus(nextStatus);
    setPage(1);
  }

  function updateOwnerClassification(nextOwnerClassification: OwnerFilter) {
    setOwnerClassification(nextOwnerClassification);
    setPage(1);
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Stripe Disputes</h2>
          <p className="text-muted-foreground max-w-4xl">
            Review actionable Stripe disputes and accept them only after confirming the owner match.
            Accepting closes the Stripe dispute first, then records Kilo-side enforcement actions.
          </p>
        </div>
        <Badge variant="secondary" className="h-fit self-start">
          <ShieldCheck className="size-3" /> Admin-gated
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Dispute queue</CardTitle>
          <CardDescription>
            Default view shows response-needed disputes, sorted by evidence deadline. Countering is
            handled in Stripe and does not mutate Kilo records.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs font-medium">Status</span>
              <Select
                value={status}
                onValueChange={value => updateStatus(value as DisputeStatusFilter)}
              >
                <SelectTrigger className="w-full md:w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs font-medium">Owner</span>
              <Select
                value={ownerClassification}
                onValueChange={value => updateOwnerClassification(value as OwnerFilter)}
              >
                <SelectTrigger className="w-full md:w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ownerOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          {casesQuery.isError ? (
            <p className="text-destructive text-sm" role="alert">
              Disputes could not be loaded. Refresh the page to try again.
            </p>
          ) : (
            <>
              <DisputesTable
                rows={rows}
                isLoading={casesQuery.isLoading}
                onAccept={row => {
                  setSelectedCase(row);
                  setConfirmationText('');
                }}
                isAccepting={acceptMutation.isPending}
              />
              <div className="flex flex-col items-start justify-between gap-3 text-sm sm:flex-row sm:items-center">
                <p className="text-muted-foreground">
                  {pagination
                    ? `${pagination.total} dispute${pagination.total === 1 ? '' : 's'}`
                    : 'Loading dispute count...'}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPage(current => Math.max(1, current - 1))}
                    disabled={page <= 1 || casesQuery.isFetching}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPage(current => current + 1)}
                    disabled={!pagination || page >= pagination.totalPages || casesQuery.isFetching}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AcceptDisputeDialog
        dispute={selectedCase}
        isPending={acceptMutation.isPending}
        needsTypedConfirm={selectedCaseNeedsTypedConfirm}
        confirmationText={confirmationText}
        canConfirm={canConfirmSelectedCase}
        onConfirmationTextChange={setConfirmationText}
        onOpenChange={open => {
          if (!open && !acceptMutation.isPending) {
            setSelectedCase(null);
            setConfirmationText('');
          }
        }}
        onConfirm={() => {
          if (selectedCase && canConfirmSelectedCase) {
            acceptMutation.mutate({ caseId: selectedCase.id });
          }
        }}
      />
    </div>
  );
}

function DisputesTable({
  rows,
  isLoading,
  onAccept,
  isAccepting,
}: {
  rows: DisputeRow[];
  isLoading: boolean;
  onAccept: (row: DisputeRow) => void;
  isAccepting: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Deadline</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Linked account</TableHead>
            <TableHead>Stripe identifiers</TableHead>
            <TableHead>Enforcement</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-muted-foreground h-24 text-center">
                {isLoading ? 'Loading disputes...' : 'No disputes match these filters.'}
              </TableCell>
            </TableRow>
          ) : (
            rows.map(row => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap text-sm">
                  <div className="flex flex-col gap-1">
                    <span>{formatTimestamp(row.evidenceDueBy)}</span>
                    <span className="text-muted-foreground text-xs">
                      Created {formatTimestamp(row.stripeCreatedAt ?? row.createdAt)}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <Badge variant="outline" className={statusBadgeClass(row.status)}>
                      {formatStatus(row.status)}
                    </Badge>
                    {row.stripeStatus ? (
                      <span className="text-muted-foreground text-xs">
                        Stripe: {row.stripeStatus}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={ownerBadgeClass(row.ownerClassification)}>
                    {formatOwnerClassification(row.ownerClassification)}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap font-mono text-sm tabular-nums">
                  <div className="flex flex-col gap-1">
                    <span>{formatAmount(row.amountMinorUnits, row.currency)}</span>
                    <span className="text-muted-foreground text-xs">
                      {row.disputeReason ?? 'No reason'}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="min-w-52 text-sm">{renderLinkedAccount(row)}</TableCell>
                <TableCell className="min-w-64 text-xs">
                  <StripeIdentifiers row={row} />
                </TableCell>
                <TableCell className="min-w-72 text-sm">
                  <EnforcementSummary row={row} />
                </TableCell>
                <TableCell>
                  <div className="flex min-w-44 justify-end gap-2">
                    <Button variant="secondary" size="sm" asChild>
                      <a
                        href={stripeDisputeUrl(row.stripeDisputeId)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Counter
                        <ExternalLink className="size-3" />
                      </a>
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onAccept(row)}
                      disabled={!canAccept(row) || isAccepting}
                    >
                      {row.status === 'processing' ? 'Retry' : 'Accept'}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function AcceptDisputeDialog({
  dispute,
  isPending,
  needsTypedConfirm,
  confirmationText,
  canConfirm,
  onConfirmationTextChange,
  onOpenChange,
  onConfirm,
}: {
  dispute: DisputeRow | null;
  isPending: boolean;
  needsTypedConfirm: boolean;
  confirmationText: string;
  canConfirm: boolean;
  onConfirmationTextChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={Boolean(dispute)} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Accept Stripe dispute</AlertDialogTitle>
          <AlertDialogDescription>
            This closes the Stripe dispute as lost. Kilo enforcement runs only after Stripe accepts
            the close call, and no extra refund is created.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {dispute ? (
          <div className="space-y-4 text-sm">
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="font-mono text-xs">{dispute.stripeDisputeId}</div>
              <div className="text-muted-foreground mt-1">
                {formatAmount(dispute.amountMinorUnits, dispute.currency)} ·{' '}
                {formatOwnerClassification(dispute.ownerClassification)} ·{' '}
                {dispute.disputeReason ?? 'No reason'}
              </div>
            </div>
            <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{acceptanceImpactCopy(dispute)}</p>
            </div>
            {needsTypedConfirm ? (
              <label className="flex flex-col gap-2">
                <span className="text-muted-foreground text-xs font-medium">
                  Type the dispute ID to retry a failed, stale, or partially enforced case.
                </span>
                <Input
                  value={confirmationText}
                  onChange={event => onConfirmationTextChange(event.target.value)}
                  placeholder={dispute.stripeDisputeId}
                />
              </label>
            ) : null}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isPending || !canConfirm}>
            {isPending ? 'Accepting...' : 'Accept dispute'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function EnforcementSummary({ row }: { row: DisputeRow }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted-foreground">
        {row.statusReason ?? 'No status reason recorded'}
      </span>
      {row.failureContext ? (
        <span className="text-destructive whitespace-pre-wrap">{row.failureContext}</span>
      ) : null}
      {row.actions.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {row.actions.map(action => (
            <Badge key={action.id} variant="outline" className={actionBadgeClass(action.status)}>
              {formatActionLabel(action.actionType)}: {formatStatus(action.status)}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StripeIdentifiers({ row }: { row: DisputeRow }) {
  return (
    <div className="flex flex-col gap-1 font-mono">
      <a
        href={stripeDisputeUrl(row.stripeDisputeId)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
      >
        {row.stripeDisputeId}
        <ExternalLink className="size-3 shrink-0" />
      </a>
      {row.stripeChargeId ? (
        <a
          href={stripePaymentUrl(row.stripeChargeId)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
        >
          {row.stripeChargeId}
          <ExternalLink className="size-3 shrink-0" />
        </a>
      ) : null}
      {row.stripePaymentIntentId ? <span>{row.stripePaymentIntentId}</span> : null}
      {row.stripeCustomerId ? (
        <a
          href={stripeCustomerUrl(row.stripeCustomerId)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
        >
          {row.stripeCustomerId}
          <ExternalLink className="size-3 shrink-0" />
        </a>
      ) : null}
    </div>
  );
}

function renderLinkedAccount(row: DisputeRow) {
  if (row.user) {
    return (
      <Link
        className="text-blue-400 hover:text-blue-300"
        href={`/admin/users/${encodeURIComponent(row.user.id)}`}
      >
        {row.user.email}
      </Link>
    );
  }

  if (row.organization) {
    return (
      <Link
        className="text-blue-400 hover:text-blue-300"
        href={`/admin/organizations/${encodeURIComponent(row.organization.id)}`}
      >
        {row.organization.name}
      </Link>
    );
  }

  return <span className="text-muted-foreground">No owner linked</span>;
}

function canAccept(row: DisputeRow): boolean {
  const ownerCanBeAccepted =
    (row.ownerClassification === 'personal' && row.user !== null) ||
    (row.ownerClassification === 'organization' && row.organization !== null);
  if (!ownerCanBeAccepted) {
    return false;
  }

  if (row.status === 'processing') {
    return isProcessingRetryable(row);
  }

  return ['needs_action', 'acceptance_failed', 'enforcement_failed'].includes(row.status);
}

function isProcessingRetryable(row: DisputeRow): boolean {
  const retryAt = timestampMillis(row.nextRetryAt);
  if (retryAt !== null) {
    return retryAt <= Date.now();
  }

  const acceptanceStartedAt = timestampMillis(row.acceptanceStartedAt);
  return (
    acceptanceStartedAt !== null && acceptanceStartedAt <= Date.now() - PROCESSING_RETRY_DELAY_MS
  );
}

function timestampMillis(value: string | null): number | null {
  if (!value) return null;
  const date = new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

function acceptanceImpactCopy(row: DisputeRow): string {
  if (row.ownerClassification === 'organization') {
    return 'Organization enforcement ends matched paid seat purchases and disables organization auto top-up. It does not block individual users.';
  }

  return 'Personal enforcement blocks the user, revokes web sessions, disables auto top-up, cancels active paid products, resets usable credits, and schedules KiloClaw data destruction after the seven-day grace period.';
}

function formatStatus(status: string): string {
  return status.replaceAll('_', ' ').replace(/^./, value => value.toUpperCase());
}

function formatOwnerClassification(classification: string): string {
  return classification.replace(/^./, value => value.toUpperCase());
}

function formatActionLabel(actionType: string): string {
  return actionType.replaceAll('_', ' ').replace(/^./, value => value.toUpperCase());
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString();
}

function formatAmount(amountMinorUnits: number | null, currency: string | null): string {
  if (amountMinorUnits === null || !currency) return 'Not available';
  return formatCents(amountMinorUnits, currency);
}

function statusBadgeClass(status: string): string {
  if (status === 'needs_action') return 'border-yellow-500/20 bg-yellow-500/10 text-yellow-400';
  if (status === 'accepted') return 'border-green-500/20 bg-green-500/10 text-green-400';
  if (status === 'acceptance_failed' || status === 'enforcement_failed') {
    return 'border-destructive/30 bg-destructive/10 text-destructive';
  }
  if (status === 'review_required') return 'border-orange-500/20 bg-orange-500/10 text-orange-400';
  return 'border-border bg-secondary text-secondary-foreground';
}

function ownerBadgeClass(ownerClassification: string): string {
  if (ownerClassification === 'ambiguous')
    return 'border-destructive/30 bg-destructive/10 text-destructive';
  if (ownerClassification === 'unmatched')
    return 'border-orange-500/20 bg-orange-500/10 text-orange-400';
  if (ownerClassification === 'organization')
    return 'border-purple-500/20 bg-purple-500/10 text-purple-400';
  return 'border-blue-500/20 bg-blue-500/10 text-blue-400';
}

function actionBadgeClass(status: string): string {
  if (status === 'completed') return 'border-green-500/20 bg-green-500/10 text-green-400';
  if (status === 'failed') return 'border-destructive/30 bg-destructive/10 text-destructive';
  if (status === 'processing') return 'border-yellow-500/20 bg-yellow-500/10 text-yellow-400';
  return 'border-border bg-secondary text-secondary-foreground';
}

function stripeDashboardPrefix(): string {
  return process.env.NODE_ENV === 'development' ? 'test/' : '';
}

function stripeDisputeUrl(disputeId: string): string {
  return `https://dashboard.stripe.com/${stripeDashboardPrefix()}disputes/${disputeId}`;
}

function stripePaymentUrl(chargeId: string): string {
  return `https://dashboard.stripe.com/${stripeDashboardPrefix()}payments/${chargeId}`;
}

function stripeCustomerUrl(customerId: string): string {
  return `https://dashboard.stripe.com/${stripeDashboardPrefix()}customers/${customerId}`;
}

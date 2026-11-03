'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/lib/trpc/utils';
import { useAdminPermissions } from '@/app/admin/useAdminPermissions';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 50;
const PREVIEW_ROWS = 50;

const badgeClass = {
  green: 'bg-green-500/20 text-green-400 ring-1 ring-green-500/20',
  zinc: 'bg-zinc-500/20 text-zinc-400 ring-1 ring-zinc-500/20',
  yellow: 'bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/20',
  red: 'bg-red-500/20 text-red-400 ring-1 ring-red-500/20',
} as const;

const rowStatus: Record<string, { label: string; tone: keyof typeof badgeClass }> = {
  refunded: { label: 'Refunded', tone: 'green' },
  already_refunded: { label: 'Already refunded', tone: 'green' },
  succeeded: { label: 'Refunded', tone: 'green' },
  skipped: { label: 'Skipped', tone: 'zinc' },
  claimed_elsewhere: { label: 'Claimed elsewhere', tone: 'zinc' },
  pending: { label: 'Pending', tone: 'yellow' },
  outcome_unknown: { label: 'Outcome unknown', tone: 'yellow' },
  failed: { label: 'Failed', tone: 'red' },
  error: { label: 'Error', tone: 'red' },
};

function formatMinor(minor: number, currency = 'usd'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(minor / 100);
}

function StatusBadge({ status }: { status: string }) {
  const meta = rowStatus[status] ?? { label: status, tone: 'zinc' as const };
  return <Badge className={badgeClass[meta.tone]}>{meta.label}</Badge>;
}

function OwnerLink({
  organizationId,
  kiloUserId,
}: {
  organizationId: string | null;
  kiloUserId: string | null;
}) {
  if (organizationId) {
    return (
      <Link
        className="text-primary hover:underline"
        href={`/admin/organizations/${encodeURIComponent(organizationId)}`}
      >
        org {organizationId}
      </Link>
    );
  }
  if (kiloUserId) {
    return (
      <Link
        className="text-primary hover:underline"
        href={`/admin/users/${encodeURIComponent(kiloUserId)}`}
      >
        {kiloUserId}
      </Link>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/50 rounded-lg border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}

export function ServiceFeeRefunds() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { isSuperadmin, isPermissionResolved } = useAdminPermissions();
  const [batchSizeInput, setBatchSizeInput] = useState(String(DEFAULT_BATCH_SIZE));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const batchSize = /^\d+$/.test(batchSizeInput.trim())
    ? Number.parseInt(batchSizeInput.trim(), 10)
    : Number.NaN;
  const validBatchSize =
    Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= MAX_BATCH_SIZE;

  const overview = useQuery(trpc.admin.serviceFeeRollback.overview.queryOptions());
  const invalidateOverview = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.admin.serviceFeeRollback.overview.queryKey(),
    });

  const executeBatch = useMutation(
    trpc.admin.serviceFeeRollback.executeBatch.mutationOptions({
      onSuccess: results => {
        const count = (...statuses: string[]) =>
          results.filter(row => statuses.includes(row.status)).length;
        const refunded = count('refunded', 'already_refunded');
        const skipped = count('skipped');
        const failed = count('failed');
        const unknown = count('outcome_unknown');
        const summary = `Processed ${results.length}: ${refunded} refunded, ${skipped} skipped, ${failed} failed, ${unknown} outcome unknown.`;
        if (skipped + failed + unknown > 0) {
          toast.warning(`${summary} Review them under Needs attention.`);
        } else {
          toast.success(summary);
        }
      },
      onError: error => toast.error(error.message || 'Refund batch failed'),
      onSettled: invalidateOverview,
    })
  );

  const reconcile = useMutation(
    trpc.admin.serviceFeeRollback.reconcileStale.mutationOptions({
      onSuccess: results => {
        const count = (status: string) => results.filter(row => row.status === status).length;
        const errors = count('error');
        const stillPending = count('pending');
        const summary = `Reconciled ${results.length}: ${count('succeeded')} refunded, ${count('failed')} queued for retry, ${stillPending} still pending, ${errors} errors.`;
        if (errors + stillPending > 0) {
          toast.warning(summary);
        } else {
          toast.success(summary);
        }
      },
      onError: error => toast.error(error.message || 'Reconcile failed'),
      onSettled: invalidateOverview,
    })
  );

  if (overview.isPending) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (overview.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{overview.error.message}</AlertDescription>
      </Alert>
    );
  }

  const data = overview.data;
  const totalsByStatus = new Map(data.claimTotals.map(row => [row.status, row]));
  const refundedTotal = totalsByStatus.get('succeeded');
  const nextBatch = data.candidates.slice(0, batchSize);
  const nextBatchMinor = nextBatch.reduce((sum, row) => sum + row.refundableFeeMinor, 0);
  const staleCount = data.claims.filter(claim => claim.isStalePending).length;
  const attentionClaims = data.claims.filter(
    claim => claim.status !== 'succeeded' || claim.awaitingWebhook
  );
  const busy = executeBatch.isPending || reconcile.isPending;
  const canAct = isPermissionResolved && isSuperadmin;

  return (
    <div className="flex flex-col gap-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Refund charged service fees</CardTitle>
          <CardDescription>
            Refunds only the 5% service fee line on each settled charge. Each fee is claimed before
            Stripe is called and re-checked against the charge&apos;s existing refunds, so running a
            batch again never refunds the same fee twice.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <SummaryStat
              label="Remaining"
              value={`${data.remaining.count} · ${formatMinor(data.remaining.amountMinor)}`}
            />
            <SummaryStat
              label="Refunded"
              value={`${refundedTotal?.count ?? 0} · ${formatMinor(refundedTotal?.amountMinor ?? 0)}`}
            />
            <SummaryStat
              label="Skipped"
              value={String(totalsByStatus.get('skipped')?.count ?? 0)}
            />
            <SummaryStat label="Failed" value={String(totalsByStatus.get('failed')?.count ?? 0)} />
            <SummaryStat
              label="Pending"
              value={String(totalsByStatus.get('pending')?.count ?? 0)}
            />
          </div>

          {isPermissionResolved && !isSuperadmin && (
            <Alert>
              <AlertDescription>
                Superadmin access is required to refund fees or reconcile pending claims.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="batch-size">Batch size (max {MAX_BATCH_SIZE})</Label>
              <Input
                id="batch-size"
                type="number"
                min={1}
                max={MAX_BATCH_SIZE}
                className="h-9 w-28"
                step={1}
                inputMode="numeric"
                aria-invalid={!validBatchSize}
                value={batchSizeInput}
                onChange={event => setBatchSizeInput(event.target.value)}
                disabled={busy || !canAct}
              />
              {!validBatchSize && (
                <p className="text-destructive text-xs">
                  Enter a whole number from 1 to {MAX_BATCH_SIZE}.
                </p>
              )}
            </div>
            <Button
              variant="destructive"
              disabled={busy || !canAct || !validBatchSize || data.remaining.count === 0}
              onClick={() => setConfirmOpen(true)}
            >
              {executeBatch.isPending
                ? 'Refunding…'
                : validBatchSize
                  ? `Refund next ${Math.min(batchSize, data.remaining.count)}`
                  : 'Refund next batch'}
            </Button>
            <Button
              variant="outline"
              disabled={busy || !canAct || staleCount === 0}
              onClick={() => reconcile.mutate()}
            >
              {reconcile.isPending ? 'Reconciling…' : `Reconcile stale pending (${staleCount})`}
            </Button>
          </div>
        </CardContent>
      </Card>

      {executeBatch.data && executeBatch.data.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Last batch</CardTitle>
          </CardHeader>
          <CardContent>
            <ResultTable
              rows={executeBatch.data.map(row => ({
                key: row.assessmentKey,
                status: row.status,
                flow: row.flow,
                organizationId: row.organizationId,
                kiloUserId: row.kiloUserId,
                amount: row.amountMinor > 0 ? formatMinor(row.amountMinor, row.currency) : '—',
                refundId: row.stripeRefundId,
                reason: row.reason,
              }))}
            />
          </CardContent>
        </Card>
      )}

      {reconcile.data && reconcile.data.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Last reconcile</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Assessment</TableHead>
                    <TableHead>Refund</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reconcile.data.map(row => (
                    <TableRow key={row.assessmentKey}>
                      <TableCell>
                        <StatusBadge status={row.status} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.assessmentKey}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.stripeRefundId ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {row.reason ?? ''}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {attentionClaims.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
            <CardDescription>
              Skipped fees need manual review in Stripe. Failed fees are retried by the next batch.
              Pending fees older than 10 minutes can be reconciled against Stripe. Refunded fees
              listed here have not yet been recorded by the refund webhook.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResultTable
              rows={attentionClaims.map(claim => ({
                key: claim.assessmentKey,
                status: claim.status,
                flow: claim.flow,
                organizationId: claim.organizationId,
                kiloUserId: claim.kiloUserId,
                amount:
                  claim.amountMinor > 0 ? formatMinor(claim.amountMinor, claim.currency) : '—',
                refundId: claim.stripeRefundId,
                reason: claim.awaitingWebhook ? 'Awaiting charge.refunded webhook' : claim.reason,
              }))}
            />
          </CardContent>
        </Card>
      )}

      {data.unsettledWithFee.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Unsettled fees</CardTitle>
            <CardDescription>
              A fee line was attached but settlement was never recorded. These are not refunded
              here. Check each invoice in Stripe: refund a paid one manually, or delete the fee item
              from an open one.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Flow</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead className="text-right">Fee</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.unsettledWithFee.map(row => (
                    <TableRow key={row.assessmentKey}>
                      <TableCell className="text-xs">{row.flow}</TableCell>
                      <TableCell className="font-mono text-xs">
                        <OwnerLink
                          organizationId={row.organizationId}
                          kiloUserId={row.kiloUserId}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.stripeInvoiceId ?? row.stripePaymentIntentId ?? '—'}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatMinor(row.chargedFeeMinor, row.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Up next</CardTitle>
          <CardDescription>
            The oldest {Math.min(PREVIEW_ROWS, data.candidates.length)} of {data.remaining.count}{' '}
            fees still to refund. Amounts are re-checked against Stripe before each refund.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.candidates.length === 0 ? (
            <p className="text-muted-foreground text-sm">No fees left to refund.</p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Flow</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Charge</TableHead>
                    <TableHead className="text-right">Fee to refund</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.candidates.slice(0, PREVIEW_ROWS).map(row => (
                    <TableRow key={row.assessmentKey}>
                      <TableCell className="text-xs">
                        {row.flow}
                        {row.previousAttempt !== null && (
                          <span className="text-muted-foreground"> · retry</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <OwnerLink
                          organizationId={row.organizationId}
                          kiloUserId={row.kiloUserId}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.stripeChargeId ?? row.stripePaymentIntentId ?? '—'}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatMinor(row.refundableFeeMinor, row.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Refund service fees</AlertDialogTitle>
            <AlertDialogDescription>
              Refund the service fee on the next {nextBatch.length}{' '}
              {nextBatch.length === 1 ? 'charge' : 'charges'}, about {formatMinor(nextBatchMinor)}.
              Refunds are sent to customers&apos; payment methods and can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                executeBatch.mutate({ limit: batchSize });
              }}
            >
              Refund {nextBatch.length}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type ResultTableRow = {
  key: string;
  status: string;
  flow: string;
  organizationId: string | null;
  kiloUserId: string | null;
  amount: string;
  refundId: string | null;
  reason: string | null;
};

function ResultTable({ rows }: { rows: ResultTableRow[] }) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Flow</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Refund</TableHead>
            <TableHead>Notes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(row => (
            <TableRow key={row.key}>
              <TableCell>
                <StatusBadge status={row.status} />
              </TableCell>
              <TableCell className="text-xs">{row.flow}</TableCell>
              <TableCell className="font-mono text-xs">
                <OwnerLink organizationId={row.organizationId} kiloUserId={row.kiloUserId} />
              </TableCell>
              <TableCell className="text-right font-mono text-xs">{row.amount}</TableCell>
              <TableCell className="font-mono text-xs">{row.refundId ?? '—'}</TableCell>
              <TableCell className="text-muted-foreground text-xs">{row.reason ?? ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

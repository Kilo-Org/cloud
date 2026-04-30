'use client';

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import Link from 'next/link';

const MAX_EMAILS = 500;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type BulkResultStatus =
  | 'cancelled_and_refunded'
  | 'skipped_no_user'
  | 'skipped_no_subscription'
  | 'skipped_already_canceled'
  | 'error';

type ResultRow = {
  email: string;
  userId: string | null;
  status: BulkResultStatus;
  refundedAmountCents: number | null;
  balanceResetAmountUsd: number | null;
  alreadyBlocked: boolean;
  error: string | null;
};

function parseEmails(raw: string): { valid: string[]; invalid: string[] } {
  const tokens = raw
    .split(/[\s,]+/)
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (EMAIL_REGEX.test(token)) {
      valid.push(token);
    } else {
      invalid.push(token);
    }
  }
  return { valid, invalid };
}

const statusLabel: Record<BulkResultStatus, string> = {
  cancelled_and_refunded: 'Cancelled & Refunded',
  skipped_no_user: 'User not found',
  skipped_no_subscription: 'No Kilo Pass',
  skipped_already_canceled: 'Already cancelled',
  error: 'Error',
};

const statusBadgeClass: Record<BulkResultStatus, string> = {
  cancelled_and_refunded: 'bg-green-900/20 text-green-400',
  skipped_no_user: 'bg-gray-800 text-gray-300',
  skipped_no_subscription: 'bg-gray-800 text-gray-300',
  skipped_already_canceled: 'bg-yellow-900/20 text-yellow-400',
  error: 'bg-red-900/20 text-red-400',
};

const statusGroupOrder: BulkResultStatus[] = [
  'cancelled_and_refunded',
  'error',
  'skipped_already_canceled',
  'skipped_no_subscription',
  'skipped_no_user',
];

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function KiloPassBulkCancel() {
  const trpc = useTRPC();
  const [rawEmails, setRawEmails] = useState('');
  const [reason, setReason] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { valid: emails, invalid: invalidEmails } = useMemo(
    () => parseEmails(rawEmails),
    [rawEmails]
  );
  const overLimit = emails.length > MAX_EMAILS;

  const mutation = useMutation(
    trpc.admin.kiloPass.cancelAndRefundKiloPassBulk.mutationOptions({
      onSuccess: outcome => {
        toast.success(
          `Done. Cancelled ${outcome.summary.cancelled}, skipped ${outcome.summary.skipped}, errored ${outcome.summary.errored}.`
        );
      },
      onError: err => {
        toast.error(err.message || 'Bulk cancel failed');
      },
    })
  );

  const canSubmit =
    emails.length > 0 && !overLimit && reason.trim().length > 0 && !mutation.isPending;

  function handleSubmitClick() {
    if (!canSubmit) return;
    setConfirmOpen(true);
  }

  function handleConfirm() {
    setConfirmOpen(false);
    mutation.mutate({ emails, reason: reason.trim() });
  }

  const results = mutation.data?.results;
  const summary = mutation.data?.summary;

  const groupedResults = useMemo(() => {
    if (!results) return null;
    const groups = new Map<BulkResultStatus, ResultRow[]>();
    for (const row of results) {
      const list = groups.get(row.status) ?? [];
      list.push(row);
      groups.set(row.status, list);
    }
    return groups;
  }, [results]);

  return (
    <div className="flex flex-col gap-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Input</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="emails">Emails (newline- or comma-separated, max {MAX_EMAILS})</Label>
            <Textarea
              id="emails"
              rows={10}
              placeholder="alice@example.com&#10;bob@example.com&#10;..."
              value={rawEmails}
              onChange={e => setRawEmails(e.target.value)}
            />
            <div className="text-muted-foreground flex flex-wrap gap-x-4 text-xs">
              <span>{emails.length.toLocaleString()} valid unique emails</span>
              {invalidEmails.length > 0 && (
                <span className="text-red-400">
                  {invalidEmails.length} invalid token{invalidEmails.length === 1 ? '' : 's'}{' '}
                  ignored
                </span>
              )}
              {overLimit && <span className="text-red-400">Over limit of {MAX_EMAILS}</span>}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reason">Reason (required)</Label>
            <Input
              id="reason"
              placeholder="e.g. abuse/chargeback-fraud/policy-violation"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </div>

          <Alert>
            <AlertDescription>
              For each email: cancels the Stripe subscription immediately, refunds the latest paid
              invoice, resets balance to $0, blocks the account if not already blocked, and inserts
              an admin note tagged <code>[bulk]</code>. Each user runs in its own DB transaction;
              partial failures leave successful users committed.
            </AlertDescription>
          </Alert>

          <div className="flex items-center gap-3">
            <Button variant="destructive" disabled={!canSubmit} onClick={handleSubmitClick}>
              {mutation.isPending ? 'Processing…' : 'Cancel + refund + block'}
            </Button>
            {mutation.isPending && (
              <span className="text-muted-foreground text-sm">
                Running sequentially, please wait…
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {summary && results && groupedResults && (
        <Card>
          <CardHeader>
            <CardTitle>Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <SummaryStat label="Total" value={summary.total.toString()} />
              <SummaryStat
                label="Refunded total"
                value={formatUsd(summary.totalRefundedCents)}
                highlight
              />
              <SummaryStat label="Cancelled" value={summary.cancelled.toString()} />
              <SummaryStat label="Skipped" value={summary.skipped.toString()} />
              <SummaryStat label="Errored" value={summary.errored.toString()} />
            </div>

            {statusGroupOrder.map(status => {
              const rows = groupedResults.get(status);
              if (!rows || rows.length === 0) return null;
              return (
                <div key={status} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge className={statusBadgeClass[status]}>{statusLabel[status]}</Badge>
                    <span className="text-muted-foreground text-sm">
                      {rows.length} {rows.length === 1 ? 'user' : 'users'}
                    </span>
                  </div>
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Email</TableHead>
                          <TableHead>User</TableHead>
                          <TableHead className="text-right">Refunded</TableHead>
                          <TableHead className="text-right">Balance reset</TableHead>
                          <TableHead>Notes</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map(row => (
                          <TableRow key={row.email}>
                            <TableCell className="font-mono text-xs">{row.email}</TableCell>
                            <TableCell className="text-xs">
                              {row.userId ? (
                                <Link
                                  className="text-primary hover:underline"
                                  href={`/admin/users/${encodeURIComponent(row.userId)}`}
                                >
                                  {row.userId}
                                </Link>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {row.refundedAmountCents != null
                                ? formatUsd(row.refundedAmountCents)
                                : '—'}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {row.balanceResetAmountUsd != null
                                ? `$${row.balanceResetAmountUsd.toFixed(2)}`
                                : '—'}
                            </TableCell>
                            <TableCell className="text-xs">
                              {row.status === 'error' ? (
                                <span className="text-red-400">{row.error}</span>
                              ) : row.status === 'cancelled_and_refunded' && row.alreadyBlocked ? (
                                <span className="text-muted-foreground">
                                  Account was already blocked
                                </span>
                              ) : (
                                ''
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm bulk cancel</AlertDialogTitle>
            <AlertDialogDescription>
              Cancel + refund Kilo Pass and block {emails.length}{' '}
              {emails.length === 1 ? 'user' : 'users'}. This is irreversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirm}>
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="bg-muted/50 rounded-lg border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className={`font-mono text-lg font-semibold ${highlight ? 'text-green-400' : ''}`}>
        {value}
      </div>
    </div>
  );
}

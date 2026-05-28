'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { ExternalLink } from 'lucide-react';
import Link from 'next/link';

import type { RootRouter } from '@/routers/root-router';
import { useTRPC } from '@/lib/trpc/utils';
import { formatCents } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const PAGE_SIZE = 25;
type RouterOutputs = inferRouterOutputs<RootRouter>;
export type EarlyFraudWarningRow =
  RouterOutputs['admin']['earlyFraudWarnings']['list']['rows'][number];

export function EarlyFraudWarningsContent() {
  const trpc = useTRPC();
  const [page, setPage] = useState(1);
  const casesQuery = useQuery(
    trpc.admin.earlyFraudWarnings.list.queryOptions({ page, limit: PAGE_SIZE })
  );
  const rows = casesQuery.data?.rows ?? [];
  const pagination = casesQuery.data?.pagination;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold">Early Fraud Warnings</h2>
        <p className="text-muted-foreground max-w-4xl">
          Review new Stripe warnings captured during the observation rollout. This view is
          read-only; captured cases do not restrict access, refund payments, or schedule automated
          actions.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Captured warnings</CardTitle>
          <CardDescription>
            One row is stored per newly delivered warning. Personal matches remain manual-review
            cases during observation.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {casesQuery.isError ? (
            <p className="text-destructive text-sm" role="alert">
              Warning cases could not be loaded. Refresh the page to try again.
            </p>
          ) : (
            <>
              <EarlyFraudWarningsTable rows={rows} isLoading={casesQuery.isLoading} />
              <div className="flex flex-col items-start justify-between gap-3 text-sm sm:flex-row sm:items-center">
                <p className="text-muted-foreground">
                  {pagination
                    ? `${pagination.total} captured warning${pagination.total === 1 ? '' : 's'}`
                    : 'Loading warning count...'}
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
    </div>
  );
}

export function EarlyFraudWarningsTable({
  rows,
  isLoading,
}: {
  rows: EarlyFraudWarningRow[];
  isLoading: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Received</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Linked account</TableHead>
            <TableHead>Stripe identifiers</TableHead>
            <TableHead>Review reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-muted-foreground h-24 text-center">
                {isLoading
                  ? 'Loading captured warnings...'
                  : 'No early fraud warnings captured yet.'}
              </TableCell>
            </TableRow>
          ) : (
            rows.map(row => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap text-sm">
                  {formatTimestamp(row.warningCreatedAt ?? row.createdAt)}
                </TableCell>
                <TableCell>
                  <Badge variant={row.status === 'failed' ? 'destructive' : 'secondary'}>
                    {formatStatus(row.status)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={row.ownerClassification === 'ambiguous' ? 'destructive' : 'outline'}
                  >
                    {formatOwnerClassification(row.ownerClassification)}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap font-mono text-sm tabular-nums">
                  {formatAmount(row.amountMinorUnits, row.currency)}
                </TableCell>
                <TableCell className="min-w-48 text-sm">{renderLinkedAccount(row)}</TableCell>
                <TableCell className="min-w-64 text-xs">
                  <StripeIdentifiers row={row} />
                </TableCell>
                <TableCell className="text-muted-foreground min-w-64 text-sm">
                  {row.reason ?? 'Manual review required'}
                  {row.failureContext ? (
                    <div className="text-destructive mt-1">{row.failureContext}</div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function StripeIdentifiers({ row }: { row: EarlyFraudWarningRow }) {
  return (
    <div className="flex flex-col gap-1 font-mono">
      <span>{row.stripeEarlyFraudWarningId}</span>
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

function renderLinkedAccount(row: EarlyFraudWarningRow) {
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

function formatStatus(status: string): string {
  return status.replaceAll('_', ' ').replace(/^./, value => value.toUpperCase());
}

function formatOwnerClassification(classification: string): string {
  return classification === 'personal'
    ? 'Personal observation'
    : classification.replace(/^./, value => value.toUpperCase());
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

function stripeDashboardPrefix(): string {
  return process.env.NODE_ENV === 'development' ? 'test/' : '';
}

function stripePaymentUrl(chargeId: string): string {
  return `https://dashboard.stripe.com/${stripeDashboardPrefix()}payments/${chargeId}`;
}

function stripeCustomerUrl(customerId: string): string {
  return `https://dashboard.stripe.com/${stripeDashboardPrefix()}customers/${customerId}`;
}

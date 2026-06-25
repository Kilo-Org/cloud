'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

import { LockableContainer } from '@/components/organizations/LockableContainer';
import { OrganizationPageHeader } from '@/components/organizations/OrganizationPageHeader';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useDistributeFundsToChildren,
  useOrganizationChildBalances,
} from '@/app/api/organizations/hooks';
import { formatMicrodollars } from '@/lib/admin-utils';
import { cn } from '@/lib/utils';
import { parseDollarInput } from './parseDollarInput';

type Props = {
  organizationId: string;
};

export function DistributeFundsPage({ organizationId }: Props) {
  const { data, isLoading, error } = useOrganizationChildBalances(organizationId);
  const distribute = useDistributeFundsToChildren();
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const parentBalance = data?.parentBalanceMicrodollars ?? 0;
  const hasExpiringCredits = data?.hasExpiringCredits ?? false;
  const children = useMemo(() => data?.children ?? [], [data]);

  const rows = useMemo(
    () =>
      children.map(child => {
        const raw = amounts[child.id] ?? '';
        return { child, raw, ...parseDollarInput(raw) };
      }),
    [children, amounts]
  );

  const totalMicrodollars = rows.reduce((sum, row) => sum + row.microdollars, 0);
  const remainingMicrodollars = parentBalance - totalMicrodollars;
  const overBudget = remainingMicrodollars < 0;
  const hasFieldError = rows.some(row => row.error != null);
  const canSubmit =
    !hasExpiringCredits &&
    !hasFieldError &&
    !overBudget &&
    totalMicrodollars > 0 &&
    !distribute.isPending;

  const handleSubmit = () => {
    const allocations = rows
      .filter(row => row.microdollars > 0)
      .map(row => ({ childOrganizationId: row.child.id, amountMicrodollars: row.microdollars }));
    if (allocations.length === 0) return;

    distribute.mutate(
      { organizationId, allocations },
      {
        onSuccess: result => {
          toast.success(
            `Distributed ${formatMicrodollars(result.totalMovedMicrodollars)} to ${result.childCount} child organization${result.childCount === 1 ? '' : 's'}.`
          );
          setAmounts({});
        },
        onError: mutationError => {
          toast.error(
            mutationError instanceof Error ? mutationError.message : 'Failed to distribute funds.'
          );
        },
      }
    );
  };

  return (
    <div className="flex w-full flex-col gap-y-6">
      <OrganizationPageHeader
        organizationId={organizationId}
        title="Distribute funds"
        showBackButton
      />

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Failed to load child organizations:{' '}
            {error instanceof Error ? error.message : 'Unknown error'}
          </AlertDescription>
        </Alert>
      ) : isLoading ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-4 w-96" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      ) : children.length === 0 ? (
        <Alert variant="notice">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            This organization has no child organizations to distribute funds to.
          </AlertDescription>
        </Alert>
      ) : (
        // Locked (non-interactive) for read-only orgs whose trial has expired,
        // matching the lock UI used across organization settings. The transfer
        // mutation also enforces an active subscription/trial server-side.
        <LockableContainer>
          <Card>
            <CardHeader>
              <CardTitle>Distribute funds to child organizations</CardTitle>
              <CardDescription>
                Move available balance to child organizations. The total you distribute can&apos;t
                exceed the available balance.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {hasExpiringCredits && (
                <Alert variant="warning">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    Distributing funds isn&apos;t available while this organization has expiring
                    credits.
                  </AlertDescription>
                </Alert>
              )}

              <div className="border-border flex items-baseline justify-between gap-4 border-b pb-4">
                <span className="text-muted-foreground text-sm">Available to distribute</span>
                <span className="text-lg font-semibold tabular-nums">
                  {formatMicrodollars(parentBalance)}
                </span>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organization</TableHead>
                    <TableHead className="text-right">Current balance</TableHead>
                    <TableHead className="text-right">Amount to move</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(row => {
                    const errorId = `${row.child.id}-amount-error`;
                    return (
                      <TableRow key={row.child.id}>
                        <TableCell className="font-medium">{row.child.name}</TableCell>
                        <TableCell className="text-muted-foreground text-right tabular-nums">
                          {formatMicrodollars(row.child.balanceMicrodollars)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-end gap-1">
                            <div className="relative w-36">
                              <span
                                aria-hidden
                                className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm"
                              >
                                $
                              </span>
                              <Input
                                inputMode="decimal"
                                value={row.raw}
                                placeholder="0.00"
                                aria-label={`Amount to move to ${row.child.name}`}
                                aria-invalid={row.error != null}
                                aria-describedby={row.error ? errorId : undefined}
                                disabled={hasExpiringCredits || distribute.isPending}
                                onChange={event =>
                                  setAmounts(previous => ({
                                    ...previous,
                                    [row.child.id]: event.target.value,
                                  }))
                                }
                                className={cn(
                                  'pl-7 text-right tabular-nums',
                                  row.error &&
                                    'border-destructive focus-visible:ring-destructive/40'
                                )}
                              />
                            </div>
                            {row.error && (
                              <p id={errorId} className="text-destructive text-xs">
                                {row.error}
                              </p>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell className="font-medium">Total to distribute</TableCell>
                    <TableCell />
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMicrodollars(totalMicrodollars)}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="text-muted-foreground">Remaining balance</TableCell>
                    <TableCell />
                    <TableCell
                      className={cn(
                        'text-right tabular-nums',
                        overBudget ? 'text-destructive' : 'text-muted-foreground'
                      )}
                    >
                      {formatMicrodollars(remainingMicrodollars)}
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
            <CardFooter className="justify-end gap-3">
              {overBudget && (
                <p className="text-destructive mr-auto text-sm">
                  The total exceeds the available balance.
                </p>
              )}
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {distribute.isPending ? 'Moving funds…' : 'Move funds'}
              </Button>
            </CardFooter>
          </Card>
        </LockableContainer>
      )}
    </div>
  );
}

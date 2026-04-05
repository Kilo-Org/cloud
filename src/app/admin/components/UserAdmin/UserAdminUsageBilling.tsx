'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMicrodollars, formatRelativeTime } from '@/lib/admin-utils';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { UserDetailProps } from '@/types/admin';
import type { UserBalanceUpdates } from '@/lib/recomputeUserBalances';
import { IS_DEVELOPMENT } from '@/lib/constants';
import { Input } from '@/components/ui/input';

const credit_accounting_invariants = (
  <ul className="mt-1 list-disc space-y-1 pl-4">
    <li>
      <code>
        sum(credit_transactions.amount_microdollars)
        <br />= kilocode_users.total_microdollars_acquired
      </code>
    </li>
    <li>
      <code>
        sum(microdollar_usage.cost)
        <br />= kilocode_users.microdollars_used
      </code>
    </li>
    <li>
      <code>
        sum(credit_transactions.original_baseline_microdollars_used)
        <br />= prefix-sum(prior microdollar_usage.cost)
      </code>
    </li>
    <li>
      <code>
        credit_transactions.expiration_baseline_microdollars_used
        <br />= credit_transactions.original_baseline_microdollars_used
      </code>
      <div className="ms-2">
        <b>
          <i>UNLESS</i>
        </b>{' '}
        for a given transaction with expiration the user has prior expired credit transactions that
        overlap; such baselines may be increased to account for overlap.
      </div>
    </li>
  </ul>
);
export function UserAdminUsageBilling({
  id,
  microdollars_used,
  total_microdollars_acquired,
  next_credit_expiration_at,
  auto_top_up_enabled,
  creditInfo,
  autoTopUpConfig,
}: UserDetailProps) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const [balanceResult, setBalanceResult] = useState<UserBalanceUpdates | null>(null);
  const [devDollarAmount, setDevDollarAmount] = useState('0.01');

  const recomputeBalances = useMutation(
    trpc.admin.users.recomputeBalances.mutationOptions({
      onSuccess: (data, variables) => {
        if (variables.dryRun) {
          setBalanceResult(data);
        } else {
          // Fix was applied - reset to unvalidated state and show toast
          setBalanceResult(null);
          void queryClient.invalidateQueries({ queryKey: ['admin-user', id] });
          void queryClient.invalidateQueries({ queryKey: ['admin-user-credit-transactions', id] });
          const fixes = [];
          if (data.accounting_error_mUsd !== 0)
            fixes.push(`${(data.accounting_error_mUsd / 1_000_000).toFixed(4)} USD adjustment`);
          if (data.updatesForOriginalBaseline.length > 0)
            fixes.push(`${data.updatesForOriginalBaseline.length} baselines`);
          if (data.updatesForExpirationBaseline.length > 0)
            fixes.push(`${data.updatesForExpirationBaseline.length} exp baselines`);
          toast.success(`Fixed: ${fixes.join(', ')}`);
        }
      },
      onError: err => {
        toast.error(`Failed: ${err.message}`);
      },
    })
  );

  const hasDiscrepancy =
    balanceResult !== null &&
    (balanceResult.accounting_error_mUsd !== 0 ||
      balanceResult.updatesForOriginalBaseline.length > 0 ||
      balanceResult.updatesForExpirationBaseline.length > 0);

  const messUpBalance = useMutation(
    trpc.admin.users.DEV_ONLY_messUpBalance.mutationOptions({
      onSuccess: () => {
        setBalanceResult(null);
        void queryClient.invalidateQueries({ queryKey: ['admin-user', id] });
        toast.success('Balance messed up!');
      },
      onError: err => {
        toast.error(`Failed: ${err.message}`);
      },
    })
  );

  const recomputeExpirationsMutation = useMutation<void, Error>({
    mutationFn: async () => {
      const response = await fetch(
        `/admin/api/users/${encodeURIComponent(id)}/kill-balance-cache`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to kill balance cache');
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-user', id] });
    },
  });

  const devInsertUsageRecordMutation = useMutation<void, Error>({
    mutationFn: async () => {
      const dollarAmount = Number(devDollarAmount);
      if (!Number.isFinite(dollarAmount) || dollarAmount <= 0) {
        throw new Error('Enter a valid dollar amount > 0');
      }

      const response = await fetch(
        `/admin/api/users/${encodeURIComponent(id)}/dev/insert-usage-record`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dollarAmount }),
        }
      );

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || 'Failed to insert usage record');
      }
    },
    onSuccess: () => {
      setBalanceResult(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-user', id] });
      void queryClient.invalidateQueries({ queryKey: ['admin-user-credit-transactions', id] });
      toast.success('Inserted usage record');
    },
    onError: err => {
      toast.error(`Failed: ${err.message}`);
    },
  });

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Usage & Billing</CardTitle>
        <CardDescription>Usage statistics and billing information</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <h4 className="text-muted-foreground text-sm font-medium">Current Balance</h4>
            <p className="font-mono text-2xl font-bold">${creditInfo.balance.toFixed(2)}</p>
          </div>
          <div>
            <h4 className="text-muted-foreground text-sm font-medium">Total Usage</h4>
            <p className="font-mono text-2xl font-bold">{formatMicrodollars(microdollars_used)}</p>
          </div>
          <div>
            <h4 className="text-muted-foreground text-sm font-medium">Auto Top-Up</h4>
            <p
              className={
                auto_top_up_enabled ? 'font-medium text-green-600' : 'text-muted-foreground'
              }
            >
              {auto_top_up_enabled ? 'Enabled' : 'Disabled'}
            </p>
            {autoTopUpConfig && (
              <div className="text-muted-foreground mt-1 text-sm">
                <p>Amount: ${(autoTopUpConfig.amount_cents / 100).toFixed(0)}</p>
                {autoTopUpConfig.last_auto_top_up_at && (
                  <p>Last: {formatRelativeTime(autoTopUpConfig.last_auto_top_up_at)}</p>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="mt-4 mb-4">
          <Accordion type="single" collapsible className="w-full" defaultValue="extra-info">
            <AccordionItem value="extra-info">
              <AccordionTrigger className="text-sm font-medium">
                Extra information for Developers
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <h4 className="text-muted-foreground text-sm font-medium">Total Acquired</h4>
                    <p className="font-mono text-2xl font-bold">
                      {formatMicrodollars(total_microdollars_acquired)}
                    </p>
                  </div>
                  <div>
                    <h4 className="text-muted-foreground text-sm font-medium">
                      Next Credit Expiration
                    </h4>
                    <p>
                      {next_credit_expiration_at
                        ? formatRelativeTime(next_credit_expiration_at)
                        : 'None'}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => recomputeExpirationsMutation.mutate()}
                      disabled={recomputeExpirationsMutation.isPending}
                    >
                      {recomputeExpirationsMutation.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Checking...
                        </>
                      ) : (
                        'Force expiration check'
                      )}
                    </Button>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
        <div>
          <h4 className="text-sm font-medium">Balance Validation</h4>
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => recomputeBalances.mutate({ userId: id, dryRun: true })}
                    disabled={recomputeBalances.isPending}
                  >
                    {recomputeBalances.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Checking...
                      </>
                    ) : (
                      'Check Balance'
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-lg">
                  <p>
                    Verify user balance + credit transaction baselines match the usage ledger (dry
                    run).
                  </p>
                  <p className="mt-2">We&apos;re checking the invariants that:</p>
                  {credit_accounting_invariants}
                </TooltipContent>
              </Tooltip>
              {balanceResult !== null && !hasDiscrepancy && (
                <span className="flex items-center gap-1">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <span className="text-sm text-green-500">OK</span>
                </span>
              )}
              {IS_DEVELOPMENT && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => messUpBalance.mutate({ userId: id })}
                      disabled={messUpBalance.isPending}
                    >
                      {messUpBalance.isPending
                        ? '...'
                        : '🧪 Intentionally corrupt baselines+balance'}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    DEV ONLY: Randomly jitter balance and baselines to test validation
                  </TooltipContent>
                </Tooltip>
              )}
            </div>

            {IS_DEVELOPMENT && (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={devDollarAmount}
                  onChange={e => setDevDollarAmount(e.target.value)}
                  className="max-w-40"
                  disabled={devInsertUsageRecordMutation.isPending}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => devInsertUsageRecordMutation.mutate()}
                      disabled={devInsertUsageRecordMutation.isPending}
                    >
                      {devInsertUsageRecordMutation.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Inserting...
                        </>
                      ) : (
                        '🧪 Insert usage record'
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    DEV ONLY: Inserts a microdollar_usage row for this user (updates their ledger +
                    balance)
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
            {hasDiscrepancy && (
              <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
                  <div className="flex-1 space-y-1">
                    <div className="text-sm text-yellow-500">
                      {balanceResult.accounting_error_mUsd !== 0 && (
                        <div>
                          Accounting error:{' '}
                          {(balanceResult.accounting_error_mUsd / 1_000_000).toFixed(4)} USD
                        </div>
                      )}
                      {balanceResult.updatesForOriginalBaseline.length > 0 && (
                        <div>
                          Original baselines to fix:{' '}
                          {balanceResult.updatesForOriginalBaseline.length}
                          <ul className="mt-1 list-none space-y-0.5 font-mono text-xs">
                            {balanceResult.updatesForOriginalBaseline.map(u => (
                              <li key={u.id}>
                                {u.id}: ${((u.db ?? 0) / 1_000_000).toFixed(4)} → $
                                {(u.baseline / 1_000_000).toFixed(4)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {balanceResult.updatesForExpirationBaseline.length > 0 && (
                        <div>
                          Expiration baselines to fix:{' '}
                          {balanceResult.updatesForExpirationBaseline.length}
                          <ul className="mt-1 list-none space-y-0.5 font-mono text-xs">
                            {balanceResult.updatesForExpirationBaseline.map(u => (
                              <li key={u.id}>
                                {u.id}: ${((u.db ?? 0) / 1_000_000).toFixed(4)} → $
                                {(u.baseline / 1_000_000).toFixed(4)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => recomputeBalances.mutate({ userId: id, dryRun: false })}
                          disabled={recomputeBalances.isPending}
                        >
                          {recomputeBalances.isPending ? (
                            <>
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              Fixing...
                            </>
                          ) : (
                            'Fix Discrepancies'
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-lg">
                        <p>Apply corrections: insert accounting adjustment and fix baselines.</p>
                        <p className="mt-2">We&apos;re restoring the invariants that:</p>
                        {credit_accounting_invariants}
                        <p className="mt-2">
                          This fix IGNORES the overlap of not-yet-expired credits with
                          already-expired credits and can result in baselines that are too low. This
                          is always in the user's advantage: it simply means that usage can be
                          counted towards the budget of two credit transactions, meaning the user
                          needs less usage to avoid expiration if they have multiple overlapping
                          expiring credits.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

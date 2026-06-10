'use client';

import React, { useState } from 'react';
import { Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTRPC } from '@/lib/trpc/utils';

type ReferralProduct = 'kiloclaw' | 'kilo_pass';

type InvestigationResult = {
  product: ReferralProduct;
  productLabel: string;
  referrer: { id: string; email: string | null; name: string | null };
  participantRegistrations: Array<{
    id: string;
    programKey: ReferralProduct;
    registrationState: string;
    registeredAt: string | null;
    lastRegistrationAttemptAt: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    latestAttempt: {
      id: string;
      deliveryState: string;
      responseStatusCode: number | null;
      nextRetryAt: string | null;
      createdAt: string;
    } | null;
  }>;
  referrals: Array<{
    referral: {
      id: string;
      product: ReferralProduct;
      productLabel: string;
      impactReferralId: string | null;
      createdAt: string;
    };
    referee: { id: string; email: string | null; name: string | null };
    sourceTouch: {
      id: string;
      provider: string | null;
      touchType: string | null;
      landingPath: string | null;
      rsCode: string | null;
      imRef: string | null;
      touchedAt: string | null;
      expiresAt: string | null;
    } | null;
    conversion: {
      id: string;
      product: ReferralProduct;
      paymentProvider: string;
      winningTouchType: string;
      sourcePaymentId: string;
      qualified: boolean;
      disqualificationReason: string | null;
      convertedAt: string;
    } | null;
    rewardDecisions: Array<{
      id: string;
      product: ReferralProduct;
      beneficiaryUserId: string;
      beneficiaryRole: string;
      outcome: string;
      reason: string | null;
      rewardKind: string;
      monthsGranted: number;
      rewardPercent: number | null;
      sourceTier: string | null;
      rewardAmountUsd: number | null;
      createdAt: string;
    }>;
    rewards: Array<{
      id: string;
      product: ReferralProduct;
      beneficiaryUserId: string;
      beneficiaryRole: string;
      rewardKind: string;
      status: string;
      monthsGranted: number;
      rewardPercent: number | null;
      sourceTier: string | null;
      rewardAmountUsd: number | null;
      earnedAt: string;
      appliedAt: string | null;
      expiresAt: string | null;
      reviewReason: string | null;
      appliesToKiloPassSubscriptionId: string | null;
      consumedKiloPassIssuanceId: string | null;
      consumedKiloPassIssuanceItemId: string | null;
    }>;
    rewardApplications: Array<{
      id: string;
      product: ReferralProduct;
      beneficiaryUserId: string;
      subscriptionId: string | null;
      previousRenewalBoundary: string;
      newRenewalBoundary: string;
      localOperationId: string | null;
      stripeOperationId: string | null;
      appliedAt: string;
    }>;
    impactReports: Array<{
      id: string;
      state: string;
      actionTrackerId: number;
      orderId: string;
      deliveredAt: string | null;
      nextRetryAt: string | null;
      responseStatusCode: number | null;
    }>;
    impactRewardRedemptions: Array<{
      id: string;
      rewardId: string;
      beneficiaryUserId: string;
      state: string;
      impactRewardId: string | null;
      redeemedAt: string | null;
      nextRetryAt: string | null;
      responseStatusCode: number | null;
    }>;
  }>;
};

const PRODUCT_OPTIONS: Array<{ value: ReferralProduct; label: string }> = [
  { value: 'kiloclaw', label: 'KiloClaw' },
  { value: 'kilo_pass', label: 'Kilo Pass' },
];

type ResultsProps = {
  result: InvestigationResult;
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function outcomeLabel(qualified: boolean): string {
  return qualified ? 'Qualified' : 'Disqualified';
}

function formatRewardValue(row: {
  monthsGranted?: number;
  rewardAmountUsd?: number | null;
}): string {
  if (row.rewardAmountUsd != null) return `$${row.rewardAmountUsd.toFixed(2)}`;
  if (row.monthsGranted != null) {
    return `${row.monthsGranted} month${row.monthsGranted === 1 ? '' : 's'}`;
  }
  return '—';
}

export function KiloclawReferralsInvestigationResults({ result }: ResultsProps) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Referrer</CardTitle>
          <CardDescription>
            Support investigation details for this {result.productLabel} referrer.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm md:grid-cols-3">
          <Detail label="User ID" value={result.referrer.id} />
          <Detail label="Email" value={result.referrer.email ?? '—'} />
          <Detail label="Name" value={result.referrer.name ?? '—'} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Participant registration</CardTitle>
          <CardDescription>
            Impact Advocate registration state for the selected referral program.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {result.participantRegistrations.length === 0 ? (
            <div className="text-muted-foreground rounded-lg border border-dashed border-border p-4 text-sm">
              No participant registration found for this {result.productLabel} program.
            </div>
          ) : (
            result.participantRegistrations.map(participant => (
              <div key={participant.id} className="rounded-md bg-muted/40 px-3 py-2">
                <div className="font-medium text-foreground">
                  {participant.programKey}: {participant.registrationState}
                </div>
                <div className="text-muted-foreground mt-1">
                  Latest attempt:{' '}
                  {participant.latestAttempt
                    ? `${participant.latestAttempt.deliveryState}${
                        participant.latestAttempt.responseStatusCode
                          ? `, HTTP ${participant.latestAttempt.responseStatusCode}`
                          : ''
                      }`
                    : 'none'}
                  {participant.latestAttempt?.nextRetryAt
                    ? `, retries ${formatDate(participant.latestAttempt.nextRetryAt)}`
                    : ''}
                </div>
                {participant.lastErrorCode ? (
                  <div className="text-muted-foreground mt-1">
                    Last failure: {participant.lastErrorCode}
                    {participant.lastErrorMessage ? `, ${participant.lastErrorMessage}` : ''}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{result.productLabel} referees</CardTitle>
          <CardDescription>
            Includes qualified and disqualified referrals, reward decisions, applications, and
            Impact report state.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {result.referrals.length === 0 ? (
            <div className="text-muted-foreground rounded-lg border border-dashed border-border p-4 text-sm">
              No referees found for this referrer.
            </div>
          ) : (
            result.referrals.map(row => <ReferralDiagnosticsRow key={row.referral.id} row={row} />)
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ReferralDiagnosticsRow({ row }: { row: InvestigationResult['referrals'][number] }) {
  const conversion = row.conversion;
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="font-medium text-foreground">{row.referee.email ?? row.referee.id}</div>
          <div className="text-muted-foreground mt-1 text-xs">
            {row.referral.productLabel} · {row.referee.id}
          </div>
        </div>
        {conversion ? (
          <span
            className={
              conversion.qualified
                ? 'inline-flex w-fit rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-400 ring-1 ring-emerald-500/20'
                : 'inline-flex w-fit rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400 ring-1 ring-red-500/20'
            }
          >
            {outcomeLabel(conversion.qualified)}
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid gap-4 text-sm lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Conversion
          </h3>
          {conversion ? (
            <div className="space-y-1">
              <Detail label="Source payment" value={conversion.sourcePaymentId} />
              <Detail label="Payment provider" value={conversion.paymentProvider} />
              <Detail label="Winning touch" value={conversion.winningTouchType} />
              <Detail label="Converted" value={formatDate(conversion.convertedAt)} />
              <Detail label="Reason" value={conversion.disqualificationReason ?? '—'} />
            </div>
          ) : (
            <div className="text-muted-foreground">No conversion recorded.</div>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Reward decisions
          </h3>
          {row.rewardDecisions.length === 0 ? (
            <div className="text-muted-foreground">No reward decisions.</div>
          ) : (
            <div className="space-y-1">
              {row.rewardDecisions.map(decision => (
                <div key={decision.id} className="rounded-md bg-muted/40 px-3 py-2">
                  {decision.beneficiaryRole}: {decision.outcome}, {formatRewardValue(decision)}
                  {decision.sourceTier ? `, ${decision.sourceTier}` : ''}
                  {decision.reason ? ` (${decision.reason})` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 space-y-2 text-sm">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Rewards
        </h3>
        {row.rewards.length === 0 ? (
          <div className="text-muted-foreground">No rewards.</div>
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {row.rewards.map(reward => (
              <div key={reward.id} className="rounded-md bg-muted/40 px-3 py-2">
                {reward.beneficiaryRole}: {reward.status}, {formatRewardValue(reward)}
                {reward.appliedAt ? `, applied ${formatDate(reward.appliedAt)}` : ''}
                {reward.expiresAt ? `, expires ${formatDate(reward.expiresAt)}` : ''}
                {reward.reviewReason ? ` (${reward.reviewReason})` : ''}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-4 text-sm lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Reward applications
          </h3>
          {row.rewardApplications.length === 0 ? (
            <div className="text-muted-foreground">No reward applications.</div>
          ) : (
            row.rewardApplications.map(application => (
              <div key={application.id} className="rounded-md bg-muted/40 px-3 py-2">
                {formatDate(application.previousRenewalBoundary)} to{' '}
                {formatDate(application.newRenewalBoundary)}
              </div>
            ))
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Impact reports
          </h3>
          {row.impactReports.length === 0 ? (
            <div className="text-muted-foreground">No Impact reports.</div>
          ) : (
            row.impactReports.map(report => (
              <div key={report.id} className="rounded-md bg-muted/40 px-3 py-2">
                {report.state}, tracker {report.actionTrackerId}, order {report.orderId}
                {report.responseStatusCode ? `, HTTP ${report.responseStatusCode}` : ''}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="break-all font-medium text-foreground">{value}</div>
    </div>
  );
}

export function KiloclawReferralsInvestigation() {
  const trpc = useTRPC();
  const [search, setSearch] = useState('');
  const [product, setProduct] = useState<ReferralProduct>('kiloclaw');
  const [submittedSearch, setSubmittedSearch] = useState<string | null>(null);
  const [submittedProduct, setSubmittedProduct] = useState<ReferralProduct>('kiloclaw');
  const query = useQuery(
    trpc.admin.kiloclawReferrals.investigateReferrer.queryOptions(
      { search: submittedSearch ?? '', product: submittedProduct },
      { enabled: submittedSearch !== null }
    )
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Impact referral investigation</CardTitle>
          <CardDescription>
            Search by referrer user ID or email to inspect product-specific conversion and reward
            state.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={event => {
              event.preventDefault();
              const trimmedSearch = search.trim();
              if (trimmedSearch) {
                setSubmittedSearch(trimmedSearch);
                setSubmittedProduct(product);
              }
            }}
          >
            <div className="grid gap-2 sm:w-48">
              <Label htmlFor="referral-product">Product</Label>
              <Select
                value={product}
                onValueChange={value => {
                  if (value === 'kiloclaw' || value === 'kilo_pass') setProduct(value);
                }}
              >
                <SelectTrigger id="referral-product" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_OPTIONS.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid flex-1 gap-2">
              <Label htmlFor="kiloclaw-referrer-search">Referrer user ID or email</Label>
              <Input
                id="kiloclaw-referrer-search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="user_... or referrer@example.com"
              />
            </div>
            <Button type="submit" disabled={!search.trim() || query.isFetching}>
              <Search className="h-4 w-4" aria-hidden="true" />
              {query.isFetching ? 'Searching referrals' : 'Search referrals'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {query.isError ? (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {query.error.message || 'Unable to load referral investigation.'}
          </CardContent>
        </Card>
      ) : null}
      {query.data ? <KiloclawReferralsInvestigationResults result={query.data} /> : null}
    </div>
  );
}

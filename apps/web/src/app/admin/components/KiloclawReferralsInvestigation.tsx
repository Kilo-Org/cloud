'use client';

import React, { useState } from 'react';
import { Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTRPC } from '@/lib/trpc/utils';

type InvestigationResult = {
  referrer: { id: string; email: string | null; name: string | null };
  referrals: Array<{
    referral: { id: string; impactReferralId: string | null; createdAt: string };
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
      winningTouchType: string;
      sourcePaymentId: string;
      qualified: boolean;
      disqualificationReason: string | null;
      convertedAt: string;
    } | null;
    rewardDecisions: Array<{
      id: string;
      beneficiaryUserId: string;
      beneficiaryRole: string;
      outcome: string;
      reason: string | null;
      monthsGranted: number;
      createdAt: string;
    }>;
    rewards: Array<{
      id: string;
      beneficiaryUserId: string;
      beneficiaryRole: string;
      status: string;
      monthsGranted: number;
      earnedAt: string;
      appliedAt: string | null;
      expiresAt: string | null;
      reviewReason: string | null;
    }>;
    rewardApplications: Array<{
      id: string;
      beneficiaryUserId: string;
      subscriptionId: string | null;
      previousRenewalBoundary: string;
      newRenewalBoundary: string;
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
  }>;
};

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

export function KiloclawReferralsInvestigationResults({ result }: ResultsProps) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Referrer</CardTitle>
          <CardDescription>
            Support investigation details for this KiloClaw referrer.
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
          <CardTitle>Referees</CardTitle>
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
          <div className="text-muted-foreground mt-1 text-xs">{row.referee.id}</div>
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
                  {decision.beneficiaryRole}: {decision.outcome}, {decision.monthsGranted} month
                  {decision.monthsGranted === 1 ? '' : 's'}
                  {decision.reason ? ` (${decision.reason})` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
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
  const [submittedSearch, setSubmittedSearch] = useState<string | null>(null);
  const query = useQuery(
    trpc.admin.kiloclawReferrals.investigateReferrer.queryOptions(
      { search: submittedSearch ?? '' },
      { enabled: submittedSearch !== null }
    )
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>KiloClaw referral investigation</CardTitle>
          <CardDescription>
            Search by referrer user ID or email to inspect referee conversion and reward state.
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
              }
            }}
          >
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

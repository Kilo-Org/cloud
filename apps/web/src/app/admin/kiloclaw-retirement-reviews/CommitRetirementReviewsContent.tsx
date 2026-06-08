'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, RefreshCcw, ShieldCheck } from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import type { RootRouter } from '@/routers/root-router';

const RESOLUTION_OPTIONS = [
  {
    value: 'deny_future_commit',
    label: 'Deny future Commit',
    description:
      'Contain provider identifiers and reconcile current row without authorizing Commit.',
  },
  {
    value: 'recognize_paid_period_as_final',
    label: 'Recognize paid period as final',
    description: 'Keep paid access through verified boundary and make it non-renewing.',
  },
] as const;

type ResolutionDisposition = (typeof RESOLUTION_OPTIONS)[number]['value'];
type ReviewStatus = 'open' | 'resolved' | 'dismissed' | 'all';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type CasePage = RouterOutputs['admin']['commitRetirementReviews']['list'];
export type CaseRow = CasePage['rows'][number];

export function flattenReviewCasePages<Row extends { reviewCase: { id: string } }>(
  pages: Array<{ rows: Row[] }>
) {
  const rows = new Map<string, Row>();
  for (const page of pages) {
    for (const row of page.rows) rows.set(row.reviewCase.id, row);
  }
  return [...rows.values()];
}

function label(value: string | null | undefined) {
  if (!value) return '—';
  return value.replaceAll('_', ' ');
}

function timestamp(value: string | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function providerSummary(provider: CaseRow['provider']) {
  if (provider.kind === 'none') return 'No provider identifiers';
  if (provider.kind === 'error') return `Provider read failed: ${provider.id}`;
  if (provider.kind === 'event') return `${provider.type} · ${provider.id}`;
  return `${provider.status} · ${provider.cancelAtPeriodEnd ? 'non-renewing' : 'renewing'} · ${provider.scheduleId ? `schedule ${provider.scheduleId}` : 'no schedule'}`;
}

function statusBadge(status: string) {
  if (status === 'open') return 'bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/20';
  if (status === 'resolved') return 'bg-green-500/20 text-green-400 ring-1 ring-green-500/20';
  return 'bg-zinc-500/20 text-zinc-400 ring-1 ring-zinc-500/20';
}

export function CommitRetirementReviewsContent() {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ReviewStatus>('open');
  const [selected, setSelected] = useState<CaseRow | null>(null);
  const [mode, setMode] = useState<'resolve' | 'dismiss'>('resolve');
  const [disposition, setDisposition] = useState<ResolutionDisposition>('deny_future_commit');
  const [reason, setReason] = useState('');

  const query = useInfiniteQuery({
    queryKey: trpc.admin.commitRetirementReviews.list.queryKey({ status, limit: 100 }),
    queryFn: ({ pageParam }) =>
      trpcClient.admin.commitRetirementReviews.list.query({
        status,
        limit: 100,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: undefined as CasePage['nextCursor'] | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: trpc.admin.commitRetirementReviews.list.queryKey(),
    });
  };

  const staleSafeInput = useMemo(() => {
    if (!selected) return null;
    return {
      caseId: selected.reviewCase.id,
      expectedCaseUpdatedAt: new Date(selected.reviewCase.updated_at).toISOString(),
      expectedSubscriptionUpdatedAt: selected.subscription
        ? new Date(selected.subscription.updated_at).toISOString()
        : null,
      expectedFinalBoundary:
        (selected.subscription?.commit_ends_at ?? selected.subscription?.current_period_end)
          ? new Date(
              selected.subscription.commit_ends_at ?? selected.subscription.current_period_end ?? ''
            ).toISOString()
          : null,
      expectedProvider: selected.provider,
      reason,
    };
  }, [reason, selected]);

  const resolveMutation = useMutation(
    trpc.admin.commitRetirementReviews.resolve.mutationOptions({
      onSuccess: async () => {
        toast.success('Retirement review resolved');
        setSelected(null);
        setReason('');
        await refresh();
      },
      onError: error => toast.error(error.message),
    })
  );
  const dismissMutation = useMutation(
    trpc.admin.commitRetirementReviews.dismiss.mutationOptions({
      onSuccess: async () => {
        toast.success('Retirement review dismissed');
        setSelected(null);
        setReason('');
        await refresh();
      },
      onError: error => toast.error(error.message),
    })
  );

  const openAction = (row: CaseRow, nextMode: 'resolve' | 'dismiss') => {
    setSelected(row);
    setMode(nextMode);
    setDisposition('deny_future_commit');
    setReason('');
  };

  const submit = () => {
    if (!staleSafeInput) return;
    if (mode === 'resolve') resolveMutation.mutate({ ...staleSafeInput, disposition });
    else dismissMutation.mutate(staleSafeInput);
  };

  const pending = resolveMutation.isPending || dismissMutation.isPending;
  const rows = flattenReviewCasePages(query.data?.pages ?? []);

  return (
    <div className="w-full space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Commit retirement reviews</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Inspect ambiguous or forbidden Commit state. Actions revalidate local and provider
            evidence and never authorize another Commit period.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={value => setStatus(value as ReviewStatus)}>
            <SelectTrigger className="w-40" aria-label="Review status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="dismissed">Dismissed</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => void refresh()} disabled={query.isFetching}>
            <RefreshCcw className={query.isFetching ? 'size-4 animate-spin' : 'size-4'} />
            Refresh
          </Button>
        </div>
      </div>

      {query.isLoading ? (
        <p className="text-muted-foreground text-sm">Loading retirement reviews...</p>
      ) : query.error ? (
        <div className="rounded-xl border bg-card p-6 text-sm text-red-400">
          Failed to load retirement reviews: {query.error.message}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="flex items-center gap-3 p-6">
            <ShieldCheck className="size-5 text-green-400" />
            <p className="text-sm">
              No {status === 'all' ? '' : `${status} `}retirement review cases.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {rows.map(row => {
            const reviewCase = row.reviewCase;
            const subscription = row.subscription;
            const canDismiss = Boolean(subscription);
            const pendingFinalTerm = Boolean(
              subscription?.plan === 'standard' && subscription.scheduled_plan === 'commit'
            );
            const standardConsent = Boolean(
              subscription?.scheduled_plan === 'standard' && subscription.scheduled_by === 'user'
            );
            const operationalState = !subscription
              ? 'Provider only'
              : pendingFinalTerm
                ? 'Pending final term'
                : standardConsent
                  ? 'Standard scheduled'
                  : subscription.plan === 'commit'
                    ? subscription.cancel_at_period_end
                      ? 'Final term non-renewing'
                      : 'Final term'
                    : 'Not Commit-involved';
            return (
              <Card key={reviewCase.id}>
                <CardHeader className="gap-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={statusBadge(reviewCase.status)}>
                          {label(reviewCase.status)}
                        </Badge>
                        <CardTitle className="text-base">{label(reviewCase.reason_code)}</CardTitle>
                        {!subscription ? (
                          <Badge className="bg-red-500/20 text-red-400 ring-1 ring-red-500/20">
                            provider only
                          </Badge>
                        ) : null}
                      </div>
                      <CardDescription>{reviewCase.summary}</CardDescription>
                    </div>
                    {reviewCase.status === 'open' ? (
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openAction(row, 'resolve')}
                        >
                          Resolve
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canDismiss}
                          title={
                            canDismiss
                              ? undefined
                              : 'Dismissal requires a known subscription already reconciled out of manual review.'
                          }
                          onClick={() => openAction(row, 'dismiss')}
                        >
                          Dismiss
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <Field title="Created" value={timestamp(reviewCase.created_at)} />
                    <Field
                      title="Qualification authority"
                      value={
                        pendingFinalTerm
                          ? 'Subscription change log'
                          : subscription?.plan === 'commit'
                            ? 'Current period'
                            : '—'
                      }
                    />
                    <Field
                      title="Qualification time"
                      value={
                        pendingFinalTerm
                          ? 'See subscription audit history'
                          : timestamp(subscription?.current_period_start)
                      }
                    />
                    <Field
                      title="Final boundary"
                      value={timestamp(
                        subscription?.commit_ends_at ?? subscription?.current_period_end
                      )}
                    />
                    <Field title="Operational state" value={operationalState} />
                    <Field title="Case reason" value={label(reviewCase.reason_code)} mono />
                    <Field
                      title="Standard consent"
                      value={standardConsent ? 'Recorded by user schedule' : 'Not recorded'}
                    />
                    <Field title="Provider evidence" value={providerSummary(row.provider)} mono />
                  </div>
                  <div className="flex flex-wrap items-center gap-3 border-t pt-3 text-xs text-muted-foreground">
                    <span className="font-mono">case {reviewCase.id}</span>
                    <span className="font-mono">dedupe {reviewCase.dedupe_key}</span>
                    {reviewCase.stripe_subscription_id ? (
                      <a
                        href={`https://dashboard.stripe.com/subscriptions/${reviewCase.stripe_subscription_id}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 text-blue-400 hover:underline"
                      >
                        Stripe subscription <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                    {row.userId ? (
                      <Button variant="ghost" size="sm" className="h-7" asChild>
                        <Link href={`/admin/users/${row.userId}`}>Open user</Link>
                      </Button>
                    ) : null}
                  </div>
                  {reviewCase.status !== 'open' ? (
                    <div className="rounded-md border bg-muted/20 p-3 text-xs">
                      <span className="font-medium">
                        Disposition: {label(reviewCase.resolution_disposition)}
                      </span>
                      <span className="text-muted-foreground ml-2">
                        {reviewCase.resolution_reason} · {timestamp(reviewCase.resolution_at)} ·{' '}
                        {reviewCase.resolution_actor_type}:{reviewCase.resolution_actor_id}
                      </span>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
          {query.hasNextPage ? (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                onClick={() => void query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? 'Loading older cases...' : 'Load older cases'}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <Dialog open={Boolean(selected)} onOpenChange={open => !open && setSelected(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {mode === 'resolve' ? 'Resolve retirement review' : 'Dismiss retirement review'}
            </DialogTitle>
            <DialogDescription>
              Current local final boundary and provider snapshot will be compared before commit.
              Stale state rejects this action. No action can create or renew Commit.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {selected?.provider.kind === 'error' ? (
              <div className="flex gap-2 rounded-md border bg-yellow-500/10 p-3 text-sm text-yellow-300">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                Provider evidence is unavailable. Action will fail closed until refresh succeeds.
              </div>
            ) : null}
            {mode === 'resolve' ? (
              <div className="space-y-2">
                <Label htmlFor="retirement-disposition">Disposition</Label>
                <Select
                  value={disposition}
                  onValueChange={value => setDisposition(value as ResolutionDisposition)}
                >
                  <SelectTrigger id="retirement-disposition" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOLUTION_OPTIONS.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  {RESOLUTION_OPTIONS.find(option => option.value === disposition)?.description}
                </p>
              </div>
            ) : (
              <div className="rounded-md border bg-muted/20 p-3 text-sm">
                Dismiss only confirms current reconciled subscription state needs no retirement
                action. Provider-only cases cannot be dismissed because their disposition must
                remain authoritative.
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="retirement-resolution-reason">Operator reason</Label>
              <Textarea
                id="retirement-resolution-reason"
                value={reason}
                maxLength={500}
                onChange={event => setReason(event.target.value)}
                placeholder="Non-sensitive reason for this disposition"
              />
              <p className="text-muted-foreground text-xs">
                Do not include email, payment details, tokens, or raw provider payloads.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSelected(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending || reason.trim().length === 0}>
              {pending ? 'Revalidating...' : mode === 'resolve' ? 'Resolve case' : 'Dismiss case'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ title, value, mono = false }: { title: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs font-medium">{title}</p>
      <p className={mono ? 'break-words font-mono text-xs' : 'text-sm'}>{value}</p>
    </div>
  );
}

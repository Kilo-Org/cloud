'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  CreditCard,
  ExternalLink,
  History,
  Rocket,
  Wallet,
} from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioButtonGroup } from '@/components/ui/RadioGroup';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useTRPC } from '@/lib/trpc/utils';
import { formatDate, formatRelativeTime } from '@/lib/admin-utils';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Types (derived from the tRPC router output)
// ---------------------------------------------------------------------------

type RouterOutputs = inferRouterOutputs<RootRouter>;
type KiloClawState = RouterOutputs['admin']['users']['getKiloClawState'];
type Subscription = KiloClawState['subscriptions'][number];

const DEFAULT_TRIAL_DAYS = 7;

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

function toLocalDateInputValue(date: string): string {
  const parsed = new Date(date);
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDateInputToEndOfDayIso(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 0).toISOString();
}

function formatJsonSummary(value: Record<string, unknown> | null | undefined): string {
  if (!value) return '—';
  return JSON.stringify(value, null, 2);
}

function formatDateCompact(date: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(date));
}

function formatStatusLabel(status: Subscription['status']) {
  if (status === 'past_due') return 'past due';
  return status;
}

function formatPlanLabel(plan: Subscription['plan']) {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function formatScopeLabel(type: 'personal' | 'organization') {
  return type === 'personal' ? 'Personal' : 'Organization';
}

function stripeSubscriptionUrl(id: string) {
  return `https://dashboard.stripe.com/subscriptions/${id}`;
}

function stripeScheduleUrl(id: string) {
  return `https://dashboard.stripe.com/subscription_schedules/${id}`;
}

// Severity model:
//   red    = broken / blocked (no access, past_due, unpaid, suspended, canceled)
//   yellow = warning / attention soon (trialing, cancels-at-period-end, deadline <7d)
//   green  = healthy (active)
function getStatusBadgeClass(status: Subscription['status']) {
  switch (status) {
    case 'active':
      return 'bg-green-900/20 text-green-400';
    case 'trialing':
      return 'bg-yellow-900/20 text-yellow-400';
    case 'past_due':
    case 'unpaid':
      return 'bg-red-900/20 text-red-400';
    case 'canceled':
      return 'bg-red-900/20 text-red-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function getAccessBadgeClass(hasAccess: boolean) {
  return hasAccess ? 'bg-green-900/20 text-green-400' : 'bg-red-900/20 text-red-400';
}

function getScope(sub: Subscription) {
  if (!sub.instance?.organization_id) {
    return { type: 'personal' as const, organizationId: null, organizationName: null };
  }
  return {
    type: 'organization' as const,
    organizationId: sub.instance.organization_id,
    organizationName: sub.instance.organization_name ?? null,
  };
}

// ---------------------------------------------------------------------------
// Chain grouping — walk `transferred_to_subscription_id` linked list so
// predecessor subscriptions nest under their tail/current record.
// ---------------------------------------------------------------------------

type Chain = { tail: Subscription; predecessors: Subscription[] };

function buildChains(subs: Subscription[]): Chain[] {
  const byId = new Map(subs.map(s => [s.id, s]));
  const tails = subs.filter(s => !s.transferred_to_subscription_id);

  const predecessorsByTarget = new Map<string, Subscription[]>();
  for (const sub of subs) {
    if (sub.transferred_to_subscription_id) {
      const list = predecessorsByTarget.get(sub.transferred_to_subscription_id) ?? [];
      list.push(sub);
      predecessorsByTarget.set(sub.transferred_to_subscription_id, list);
    }
  }

  return tails.map(tail => {
    const predecessors: Subscription[] = [];
    let cursor: Subscription | undefined = tail;
    const visited = new Set<string>([tail.id]);
    while (cursor) {
      const preds = predecessorsByTarget.get(cursor.id) ?? [];
      const unvisited = preds.filter(p => !visited.has(p.id));
      if (unvisited.length === 0) break;
      unvisited.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const next = unvisited[0];
      if (!next) break;
      visited.add(next.id);
      predecessors.push(next);
      cursor = byId.get(next.id);
    }
    return { tail, predecessors };
  });
}

// Compute the single most-relevant next date for the summary strip.
function computeNextKeyDate(sub: Subscription): {
  label: string;
  date: string;
  severity: 'neutral' | 'warn' | 'danger';
} | null {
  const urgentMs = 7 * 86_400_000;
  const now = Date.now();

  if (sub.status === 'past_due') return null;

  let label: string | null = null;
  let date: string | null = null;
  let warnWithinMs: number | null = null;

  if (sub.status === 'trialing') {
    label = 'Trial ends';
    date = sub.trial_ends_at;
    warnWithinMs = 3 * 86_400_000;
  } else if (sub.cancel_at_period_end) {
    label = 'Cancels at period end';
    date = sub.current_period_end;
    warnWithinMs = urgentMs;
  } else if (sub.status === 'active') {
    label = sub.payment_source === 'credits' ? 'Credit renewal' : 'Next renewal';
    date = sub.current_period_end;
  }

  if (!label || !date) return null;

  const msRemaining = new Date(date).getTime() - now;
  const severity: 'neutral' | 'warn' | 'danger' =
    warnWithinMs !== null && msRemaining < warnWithinMs ? 'warn' : 'neutral';

  return { label, date, severity };
}

// ---------------------------------------------------------------------------
// Small UI building blocks
// ---------------------------------------------------------------------------

function DateWithRelative({
  date,
  severity = 'neutral',
  withTime = false,
}: {
  date: string | null;
  severity?: 'neutral' | 'warn' | 'danger';
  withTime?: boolean;
}) {
  if (!date) return <span>—</span>;
  const absolute = withTime ? formatDate(date) : formatDateCompact(date);
  const relClass =
    severity === 'danger'
      ? 'text-red-400'
      : severity === 'warn'
        ? 'text-yellow-400'
        : 'text-muted-foreground';

  return (
    <span className="text-sm">
      <span>{absolute}</span>
      <span className={`ml-1.5 text-xs ${relClass}`}>({formatRelativeTime(date)})</span>
    </span>
  );
}

function StripeLink({ id, kind }: { id: string; kind: 'subscription' | 'schedule' }) {
  const url = kind === 'subscription' ? stripeSubscriptionUrl(id) : stripeScheduleUrl(id);
  const display = id.length > 24 ? `${id.slice(0, 20)}…` : id;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="group inline-flex items-center gap-1 font-mono text-xs text-blue-400 hover:underline"
    >
      <span>{display}</span>
      <ExternalLink className="h-3 w-3 opacity-60 group-hover:opacity-100" />
    </a>
  );
}

function TruncatedId({ id, label }: { id: string; label?: string }) {
  const truncated = id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
  const copy = () => {
    void navigator.clipboard.writeText(id);
    toast.success(`${label ?? 'ID'} copied to clipboard`);
  };
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 rounded border border-transparent px-1 font-mono text-xs text-muted-foreground hover:border-border hover:bg-muted/40 hover:text-foreground"
          >
            <span>{truncated}</span>
            <Copy className="h-3 w-3 opacity-60" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="font-mono text-xs">Click to copy: {id}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <h4 className="text-muted-foreground text-xs font-medium">{label}</h4>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function InstanceLink({ instance }: { instance: NonNullable<Subscription['instance']> }) {
  const displayName = instance.name ?? instance.sandbox_id;
  return (
    <Link
      href={`/admin/kiloclaw/${instance.id}`}
      className="group inline-flex items-center gap-1 text-blue-400 hover:underline"
    >
      <span className="font-medium">{displayName}</span>
      <ExternalLink className="h-3 w-3 opacity-60 group-hover:opacity-100" />
      {instance.destroyed_at ? <span className="ml-1 text-red-400">(destroyed)</span> : null}
    </Link>
  );
}

function PaymentSourceLabel({ sub }: { sub: Subscription }) {
  if (sub.payment_source === 'credits') {
    const variant = sub.stripe_subscription_id ? 'hybrid' : 'pure';
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Wallet className="h-3 w-3" />
        Credits <span className="opacity-70">({variant})</span>
      </span>
    );
  }
  if (sub.payment_source === 'stripe') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <CreditCard className="h-3 w-3" />
        Stripe
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">No payment source</span>;
}

// ---------------------------------------------------------------------------
// Early Access — canonical per-user toggle. The instance admin page mirrors
// this read-only and links here, since the underlying flag lives on the user.
// ---------------------------------------------------------------------------

function EarlyAccessRow({ userId, initialValue }: { userId: string; initialValue: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [optimistic, setOptimistic] = useState(initialValue);

  // Reset to server value if the parent's data refreshes (e.g. cache invalidate
  // from another admin tab). useState's initializer runs only on mount.
  useEffect(() => {
    setOptimistic(initialValue);
  }, [initialValue]);

  const { mutateAsync, isPending } = useMutation(
    trpc.admin.kiloclawInstances.setEarlyAccess.mutationOptions({
      onSuccess: result => {
        toast.success(
          result.earlyAccess
            ? 'Early Access enabled for this user'
            : 'Early Access disabled for this user'
        );
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.users.getKiloClawState.queryKey({ userId }),
        });
      },
      onError: err => {
        setOptimistic(initialValue);
        toast.error(`Failed to update Early Access: ${err.message}`);
      },
    })
  );

  return (
    <div className="rounded-lg border bg-card/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Rocket className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <h4 className="text-sm font-medium">Early Access</h4>
            <p className="text-muted-foreground text-xs">
              Offers this user the newest available image (including any in-flight rollout
              candidate) across all of their instances. Per-instance pins still take precedence.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={optimistic}
            disabled={isPending}
            onCheckedChange={next => {
              setOptimistic(next);
              void mutateAsync({ userId, value: next });
            }}
            aria-label="Early Access"
          />
          <span className="text-sm">
            {isPending ? (
              <span className="text-muted-foreground">Saving…</span>
            ) : optimistic ? (
              <span className="font-medium text-green-500">Enabled</span>
            ) : (
              <span className="text-muted-foreground">Disabled</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary strip — consistent access/plan/payment/next-date header.
// ---------------------------------------------------------------------------

function SummaryStrip({
  state,
  effective,
}: {
  state: KiloClawState;
  effective: Subscription | null;
}) {
  const nextDate = effective ? computeNextKeyDate(effective) : null;
  const nextDateClass =
    nextDate?.severity === 'warn'
      ? 'text-yellow-400'
      : nextDate?.severity === 'danger'
        ? 'text-red-400'
        : 'text-muted-foreground';

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-card/40 px-4 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Access:</span>
        <Badge className={getAccessBadgeClass(state.hasAccess)}>
          {state.hasAccess ? 'has access' : 'no access'}
        </Badge>
        {state.accessReason ? (
          <span className="text-xs text-muted-foreground">via {state.accessReason}</span>
        ) : null}
      </div>

      <span className="h-4 w-px bg-border" />

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Plan:</span>
        {effective ? (
          <>
            <span className="font-medium">{formatPlanLabel(effective.plan)}</span>
            <Badge className={getStatusBadgeClass(effective.status)}>
              {formatStatusLabel(effective.status)}
            </Badge>
            {effective.cancel_at_period_end ? (
              <span className="text-xs text-yellow-400">(cancels at period end)</span>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground">none</span>
        )}
      </div>

      {effective?.payment_source ? (
        <>
          <span className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Payment:</span>
            <PaymentSourceLabel sub={effective} />
          </div>
        </>
      ) : null}

      {nextDate ? (
        <>
          <span className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{nextDate.label}:</span>
            <span className="font-medium">{formatDateCompact(nextDate.date)}</span>
            <span className={`text-xs ${nextDateClass}`}>
              ({formatRelativeTime(nextDate.date)})
            </span>
          </div>
        </>
      ) : null}

      {state.earlybird ? (
        <>
          <span className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Earlybird:</span>
            <span className="font-medium">{formatDateCompact(state.earlybird.expiresAt)}</span>
            <span className="text-xs text-muted-foreground">
              ({state.earlybird.daysRemaining} days left)
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Past-due banner — single source of truth for past-due/destruction messaging.
// ---------------------------------------------------------------------------

function PastDueBanner({ sub }: { sub: Subscription }) {
  return (
    <div className="rounded-lg border border-red-500/40 bg-red-950/20 p-3 text-sm">
      <div className="flex items-center gap-2 text-red-300">
        <AlertTriangle className="h-4 w-4" />
        <span className="font-medium">Subscription is past due</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-red-100/80">
        {sub.past_due_since ? (
          <span>
            Past due since {formatDateCompact(sub.past_due_since)} (
            {formatRelativeTime(sub.past_due_since)})
          </span>
        ) : null}
        {sub.suspended_at ? (
          <span>Instance suspended {formatRelativeTime(sub.suspended_at)}</span>
        ) : null}
        {sub.destruction_deadline ? (
          <span className="font-medium text-yellow-300">
            Instance will be destroyed on {formatDate(sub.destruction_deadline)} (
            {formatRelativeTime(sub.destruction_deadline)})
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contextual field computation — only surface fields relevant to the state.
// ---------------------------------------------------------------------------

function getRelevantFields(
  sub: Subscription,
  options: { pastDueBannerShown: boolean } = { pastDueBannerShown: false }
): Array<{ label: string; value: ReactNode }> {
  const fields: Array<{ label: string; value: ReactNode }> = [];

  const scope = getScope(sub);
  const isTrial = sub.plan === 'trial';
  const isStripe = sub.payment_source === 'stripe' || !!sub.stripe_subscription_id;
  const nowMs = Date.now();

  // Organization name is already shown as a header badge; show the
  // Organization field here only when the name is unknown (ID-only fallback).
  if (scope.type === 'organization' && !scope.organizationName) {
    fields.push({
      label: 'Organization',
      value: scope.organizationId ?? '—',
    });
  }

  if (isTrial) {
    fields.push({
      label: 'Trial started',
      value: <DateWithRelative date={sub.trial_started_at} />,
    });
    fields.push({
      label: 'Trial ends',
      value: <DateWithRelative date={sub.trial_ends_at} severity="warn" withTime />,
    });
  } else {
    if (sub.trial_started_at) {
      fields.push({
        label: 'First trial started',
        value: <DateWithRelative date={sub.trial_started_at} />,
      });
    }
    const periodEndMs = sub.current_period_end ? new Date(sub.current_period_end).getTime() : null;
    const periodInPast = periodEndMs !== null && periodEndMs < nowMs;
    fields.push({
      label: 'Period',
      value: (
        <span className={`text-sm ${periodInPast ? 'text-muted-foreground' : ''}`}>
          {sub.current_period_start ? formatDateCompact(sub.current_period_start) : '—'}
          {' → '}
          {sub.current_period_end ? formatDateCompact(sub.current_period_end) : '—'}
        </span>
      ),
    });
    if (sub.plan === 'commit' && sub.commit_ends_at) {
      fields.push({
        label: 'Commit ends',
        value: <DateWithRelative date={sub.commit_ends_at} />,
      });
    }
  }

  // When the past-due banner is visible, it owns these details.
  if (!options.pastDueBannerShown && sub.past_due_since) {
    fields.push({
      label: 'Past due since',
      value: <DateWithRelative date={sub.past_due_since} severity="danger" withTime />,
    });
  }
  if (!options.pastDueBannerShown && sub.suspended_at) {
    fields.push({
      label: 'Suspended',
      value: <DateWithRelative date={sub.suspended_at} severity="danger" withTime />,
    });
  }
  // Destruction deadline is a top-signal field — always surface it when set
  // unless the past-due banner (effective sub only) already owns it.
  if (!options.pastDueBannerShown && sub.destruction_deadline) {
    fields.push({
      label: 'Destruction deadline',
      value: <DateWithRelative date={sub.destruction_deadline} severity="warn" withTime />,
    });
  }
  if (sub.scheduled_plan) {
    fields.push({
      label: 'Scheduled plan',
      value: `${formatPlanLabel(sub.scheduled_plan)}${sub.scheduled_by ? ` (${sub.scheduled_by})` : ''}`,
    });
  }
  if (sub.payment_source === 'credits' && sub.credit_renewal_at && !isTrial) {
    fields.push({
      label: 'Credit renewal',
      value: <DateWithRelative date={sub.credit_renewal_at} />,
    });
  }

  if (isStripe && sub.stripe_subscription_id) {
    fields.push({
      label: 'Stripe',
      value: <StripeLink id={sub.stripe_subscription_id} kind="subscription" />,
    });
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Subscription card (primary tail record)
// ---------------------------------------------------------------------------

type SubscriptionCardActions = {
  onChangeLog: (subscriptionId: string) => void;
  onEditTrial: (subscriptionId: string) => void;
  onCancel: (
    subscriptionId: string,
    status: Subscription['status'],
    options?: { forceImmediate?: boolean }
  ) => void;
};

function SubscriptionCard({
  sub,
  isEffective,
  historyCount,
  showHistory,
  onToggleHistory,
  historyContent,
  pastDueBannerShown,
  actions,
}: {
  sub: Subscription;
  isEffective: boolean;
  historyCount: number;
  showHistory: boolean;
  onToggleHistory: () => void;
  historyContent: ReactNode;
  pastDueBannerShown: boolean;
  actions: SubscriptionCardActions;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const scope = getScope(sub);
  const relevantFields = getRelevantFields(sub, { pastDueBannerShown });

  const canEditTrial = sub.status === 'trialing' || sub.status === 'canceled';

  // Cancel button visibility mirrors the statuses the cancelKiloClawSubscription
  // mutation accepts (active, past_due, trialing):
  //   - trialing: "Cancel Trial" (dialog forces immediate)
  //   - active/past_due + already scheduled to cancel at period end:
  //     "Cancel Immediately" (the remaining escalation; dialog forces immediate)
  //   - active/past_due (not scheduled): "Cancel" (dialog offers period_end or immediate)
  //   - anything else (canceled, unpaid): no cancel button
  const showCancel =
    sub.status === 'active' || sub.status === 'past_due' || sub.status === 'trialing';
  const cancelAlreadyScheduled =
    sub.cancel_at_period_end && (sub.status === 'active' || sub.status === 'past_due');
  const cancelLabel =
    sub.status === 'trialing'
      ? 'Cancel Trial'
      : cancelAlreadyScheduled
        ? 'Cancel Immediately'
        : 'Cancel';

  return (
    <div
      className={`rounded-lg border p-4 ${isEffective ? 'border-blue-500/40 bg-blue-950/10' : ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={getStatusBadgeClass(sub.status)}>
              {formatStatusLabel(sub.status)}
            </Badge>
            <span className="text-base font-semibold">{formatPlanLabel(sub.plan)}</span>
            <Badge variant="outline" className="text-xs">
              {formatScopeLabel(scope.type)}
            </Badge>
            {scope.type === 'organization' && scope.organizationName ? (
              <Badge variant="outline" className="text-xs">
                {scope.organizationName}
              </Badge>
            ) : null}
            {sub.cancel_at_period_end ? (
              <Badge className="bg-yellow-900/20 text-yellow-400">cancels at period end</Badge>
            ) : null}
            {sub.pending_conversion ? (
              <Badge className="bg-purple-900/20 text-purple-400">pending conversion</Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {sub.instance ? (
              <span className="inline-flex items-center gap-1">
                <span>Instance:</span>
                <InstanceLink instance={sub.instance} />
              </span>
            ) : null}
            {sub.instance && sub.payment_source ? <span>•</span> : null}
            {sub.payment_source ? <PaymentSourceLabel sub={sub} /> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => actions.onChangeLog(sub.id)}>
            <History className="mr-1 h-3 w-3" />
            Change Log
          </Button>
          {canEditTrial ? (
            <Button variant="outline" size="sm" onClick={() => actions.onEditTrial(sub.id)}>
              {sub.status === 'canceled' ? 'Reset Trial' : 'Edit Trial End'}
            </Button>
          ) : null}
          {showCancel ? (
            <Button
              variant="outline"
              size="sm"
              className="border-red-500/30 text-red-400 hover:bg-red-950/30"
              onClick={() =>
                actions.onCancel(sub.id, sub.status, {
                  forceImmediate: cancelAlreadyScheduled,
                })
              }
            >
              {cancelLabel}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-4">
        {relevantFields.map(f => (
          <Field key={f.label} label={f.label} value={f.value} />
        ))}
      </div>

      <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="mt-3">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 rounded border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/40"
          >
            {detailsOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Details (IDs, timestamps, Stripe refs)
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <div className="grid grid-cols-2 gap-3 rounded border bg-muted/10 p-3 text-sm sm:grid-cols-3 lg:grid-cols-4">
            <Field
              label="Subscription ID"
              value={<TruncatedId id={sub.id} label="Subscription ID" />}
            />
            {sub.instance_id ? (
              <Field
                label="Instance ID"
                value={<TruncatedId id={sub.instance_id} label="Instance ID" />}
              />
            ) : null}
            {sub.stripe_subscription_id ? (
              <Field
                label="Stripe Subscription"
                value={<StripeLink id={sub.stripe_subscription_id} kind="subscription" />}
              />
            ) : null}
            {sub.stripe_schedule_id ? (
              <Field
                label="Stripe Schedule"
                value={<StripeLink id={sub.stripe_schedule_id} kind="schedule" />}
              />
            ) : null}
            {sub.transferred_to_subscription_id ? (
              <Field
                label="Transferred to"
                value={<TruncatedId id={sub.transferred_to_subscription_id} label="Successor ID" />}
              />
            ) : null}
            <Field label="Created" value={<DateWithRelative date={sub.created_at} />} />
            <Field label="Updated" value={<DateWithRelative date={sub.updated_at} />} />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {historyCount > 0 ? (
        <div className="mt-3 border-t pt-3">
          <button
            type="button"
            onClick={onToggleHistory}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {showHistory ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {showHistory ? 'Hide' : 'Show'} history ({historyCount} previous subscription
            {historyCount !== 1 ? 's' : ''})
          </button>
          {showHistory ? (
            <div className="relative mt-2 space-y-1.5 border-l-2 border-muted-foreground/20 pl-4">
              {historyContent}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact row — single-line expandable. Used for predecessors and for
// standalone inactive chains.
// ---------------------------------------------------------------------------

function CompactSubscriptionRow({
  sub,
  successorId,
  onChangeLog,
}: {
  sub: Subscription;
  successorId?: string | null;
  onChangeLog: (subscriptionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trialRange =
    sub.trial_started_at && sub.trial_ends_at
      ? `${formatDateCompact(sub.trial_started_at)} → ${formatDateCompact(sub.trial_ends_at)}`
      : null;
  const periodRange =
    sub.current_period_start && sub.current_period_end
      ? `${formatDateCompact(sub.current_period_start)} → ${formatDateCompact(sub.current_period_end)}`
      : null;
  const range = trialRange ?? periodRange ?? '—';

  // The schema has no `canceled_at` column and `updated_at` may reflect later
  // mutations, so for canceled rows we only claim "last update" — for accurate
  // cancellation timing admins should open the Change Log.
  const timelineStamp =
    sub.status === 'canceled'
      ? `last update ${formatRelativeTime(sub.updated_at)}`
      : `created ${formatRelativeTime(sub.created_at)}`;

  return (
    <div className="rounded border bg-muted/10">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-muted/20"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {open ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
          <Badge className={getStatusBadgeClass(sub.status)}>{formatStatusLabel(sub.status)}</Badge>
          <span className="font-medium">{formatPlanLabel(sub.plan)}</span>
          <span className="text-muted-foreground">{range}</span>
          {successorId ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span>↑ transferred to</span>
              <TruncatedId id={successorId} label="Successor ID" />
            </span>
          ) : null}
        </div>
        <span className="shrink-0 text-muted-foreground">{timelineStamp}</span>
      </button>
      {open ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-background/40 px-3 py-2 text-xs">
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <span>ID:</span>
            <TruncatedId id={sub.id} label="Subscription ID" />
          </span>
          {sub.stripe_subscription_id ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span>Stripe:</span>
              <StripeLink id={sub.stripe_subscription_id} kind="subscription" />
            </span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onChangeLog(sub.id)}
          >
            <History className="mr-1 h-3 w-3" />
            Change Log
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk collapsed group — used when many canceled chains and no active chain.
// ---------------------------------------------------------------------------

function BulkCanceledGroup({
  chains,
  onChangeLog,
}: {
  chains: Chain[];
  onChangeLog: (subscriptionId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const startDate = chains
    .flatMap(c => [c.tail, ...c.predecessors])
    .map(s => s.trial_started_at ?? s.created_at)
    .filter((d): d is string => !!d)
    .sort()
    .at(0);
  const endDate = chains
    .flatMap(c => [c.tail, ...c.predecessors])
    .map(s => s.trial_ends_at ?? s.updated_at)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 rounded border border-dashed bg-muted/10 px-3 py-2 text-left text-sm hover:bg-muted/20"
        >
          <div className="flex items-center gap-2">
            {open ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className="font-medium">
              {chains.length} canceled subscription{chains.length === 1 ? '' : 's'}
            </span>
            {startDate && endDate ? (
              <span className="text-xs text-muted-foreground">
                {formatDateCompact(startDate)} – {formatDateCompact(endDate)}
              </span>
            ) : null}
          </div>
          <span className="text-xs text-muted-foreground">Click to expand</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-1.5">
        {chains.map(chain => (
          <CompactSubscriptionRow
            key={chain.tail.id}
            sub={chain.tail}
            successorId={chain.tail.transferred_to_subscription_id}
            onChangeLog={onChangeLog}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Section — Personal / Organization subscription groups.
// ---------------------------------------------------------------------------

function SubscriptionsSection({
  title,
  description,
  chains,
  effectiveSubscriptionId,
  expandedHistory,
  toggleHistory,
  hideInactive,
  onHideInactiveChange,
  emptyMessage,
  pastDueBannerSubId,
  actions,
}: {
  title: string;
  description: string;
  chains: Chain[];
  effectiveSubscriptionId: string | null;
  expandedHistory: Set<string>;
  toggleHistory: (tailId: string) => void;
  hideInactive: boolean;
  onHideInactiveChange: (v: boolean) => void;
  emptyMessage: string;
  pastDueBannerSubId: string | null;
  actions: SubscriptionCardActions;
}) {
  const activeChains = chains.filter(c => c.tail.status !== 'canceled');
  const canceledChains = chains.filter(c => c.tail.status === 'canceled');
  const visibleCanceled = hideInactive ? [] : canceledChains;

  // Always let admins reveal canceled chains when any exist, even if there
  // are no active chains — otherwise 1-2 canceled rows would be orphaned.
  const showToggle = canceledChains.length > 0;
  const hiddenCount = hideInactive ? canceledChains.length : 0;

  // Bulk-collapse only when there are many canceled chains to keep the
  // inactive-only view compact, but remain useful even for small counts
  // thanks to the always-visible toggle.
  const useBulkCollapse = activeChains.length === 0 && canceledChains.length >= 3;

  const renderChain = (chain: Chain) => {
    const isEffective = chain.tail.id === effectiveSubscriptionId;
    const showHistory = expandedHistory.has(chain.tail.id);
    const isStandaloneInactive =
      chain.tail.status === 'canceled' && chain.predecessors.length === 0 && !isEffective;

    if (isStandaloneInactive) {
      return (
        <CompactSubscriptionRow
          key={chain.tail.id}
          sub={chain.tail}
          successorId={chain.tail.transferred_to_subscription_id}
          onChangeLog={actions.onChangeLog}
        />
      );
    }

    return (
      <SubscriptionCard
        key={chain.tail.id}
        sub={chain.tail}
        isEffective={isEffective}
        historyCount={chain.predecessors.length}
        showHistory={showHistory}
        onToggleHistory={() => toggleHistory(chain.tail.id)}
        pastDueBannerShown={chain.tail.id === pastDueBannerSubId}
        actions={actions}
        historyContent={chain.predecessors.map(p => (
          <CompactSubscriptionRow
            key={p.id}
            sub={p}
            successorId={p.transferred_to_subscription_id}
            onChangeLog={actions.onChangeLog}
          />
        ))}
      />
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium">{title}</h4>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
        {showToggle ? (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={hideInactive}
              onChange={e => onHideInactiveChange(e.target.checked)}
              className="rounded"
            />
            Hide inactive
            {hiddenCount > 0 ? (
              <span className="text-muted-foreground">({hiddenCount} hidden)</span>
            ) : null}
          </label>
        ) : null}
      </div>

      {chains.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">{emptyMessage}</p>
      ) : useBulkCollapse && hideInactive ? (
        <BulkCanceledGroup chains={canceledChains} onChangeLog={actions.onChangeLog} />
      ) : (
        <div className="space-y-3">
          {activeChains.map(renderChain)}
          {visibleCanceled.map(renderChain)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cancel mode helper
// ---------------------------------------------------------------------------

const CANCEL_MODES = ['period_end', 'immediate'] as const;
type CancelMode = (typeof CANCEL_MODES)[number];
function isCancelMode(value: string): value is CancelMode {
  return (CANCEL_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function UserAdminKiloClaw({ userId }: { userId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [trialDialogOpen, setTrialDialogOpen] = useState(false);
  const [trialSubscriptionId, setTrialSubscriptionId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState('');

  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelSubscriptionId, setCancelSubscriptionId] = useState<string | null>(null);
  const [cancelMode, setCancelMode] = useState<CancelMode>('period_end');

  const [hideInactivePersonal, setHideInactivePersonal] = useState(true);
  const [hideInactiveOrg, setHideInactiveOrg] = useState(true);
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());

  const [changeLogSubscriptionId, setChangeLogSubscriptionId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery(
    trpc.admin.users.getKiloClawState.queryOptions({ userId })
  );

  const trialSubscription = data?.subscriptions?.find(s => s.id === trialSubscriptionId);
  const changeLogSubscription = data?.subscriptions?.find(s => s.id === changeLogSubscriptionId);
  const changeLogsQuery = useQuery(
    trpc.admin.users.getKiloClawSubscriptionChangeLogs.queryOptions(
      { userId, subscriptionId: changeLogSubscriptionId ?? '', limit: 50 },
      { enabled: Boolean(changeLogSubscriptionId) }
    )
  );

  useEffect(() => {
    if (!trialDialogOpen) return;

    const currentTrialEndAt = trialSubscription?.trial_ends_at;
    if (currentTrialEndAt && trialSubscription?.status !== 'canceled') {
      setSelectedDate(toLocalDateInputValue(currentTrialEndAt));
    } else {
      const defaultTrialEnd = new Date();
      defaultTrialEnd.setDate(defaultTrialEnd.getDate() + DEFAULT_TRIAL_DAYS);
      setSelectedDate(toLocalDateInputValue(defaultTrialEnd.toISOString()));
    }
  }, [trialSubscription?.trial_ends_at, trialSubscription?.status, trialDialogOpen]);

  const updateTrialEndAt = useMutation(
    trpc.admin.users.updateKiloClawTrialEndAt.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.admin.users.getKiloClawState.queryKey({ userId }),
        });
        setTrialDialogOpen(false);
        toast.success('KiloClaw trial end date updated');
      },
      onError: mutationError => {
        toast.error(mutationError.message || 'Failed to update KiloClaw trial end date');
      },
    })
  );

  const cancelSubscription = useMutation(
    trpc.admin.users.cancelKiloClawSubscription.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.admin.users.getKiloClawState.queryKey({ userId }),
        });
        setCancelDialogOpen(false);
        toast.success(
          cancelMode === 'immediate'
            ? 'KiloClaw subscription canceled immediately'
            : 'KiloClaw subscription set to cancel at period end'
        );
      },
      onError: mutationError => {
        toast.error(mutationError.message || 'Failed to cancel KiloClaw subscription');
      },
    })
  );

  const handleTrialSave = () => {
    if (!selectedDate || !trialSubscriptionId) {
      toast.error('Select a trial end date');
      return;
    }
    updateTrialEndAt.mutate({
      userId,
      subscriptionId: trialSubscriptionId,
      trial_ends_at: localDateInputToEndOfDayIso(selectedDate),
    });
  };

  const handleCancelConfirm = () => {
    if (!cancelSubscriptionId) return;
    cancelSubscription.mutate({
      userId,
      subscriptionId: cancelSubscriptionId,
      mode: cancelMode,
    });
  };

  const openTrialDialog = (subscriptionId: string) => {
    setTrialSubscriptionId(subscriptionId);
    setTrialDialogOpen(true);
  };

  const openCancelDialog = (
    subscriptionId: string,
    status: Subscription['status'],
    options?: { forceImmediate?: boolean }
  ) => {
    setCancelSubscriptionId(subscriptionId);
    const immediate =
      options?.forceImmediate === true || status === 'past_due' || status === 'trialing';
    setCancelMode(immediate ? 'immediate' : 'period_end');
    setCancelDialogOpen(true);
  };

  const openChangeLogDialog = (subscriptionId: string) => {
    setChangeLogSubscriptionId(subscriptionId);
  };

  const closeChangeLogDialog = () => {
    setChangeLogSubscriptionId(null);
  };

  const toggleHistory = (tailId: string) => {
    setExpandedHistory(prev => {
      const next = new Set(prev);
      if (next.has(tailId)) next.delete(tailId);
      else next.add(tailId);
      return next;
    });
  };

  const actions: SubscriptionCardActions = {
    onChangeLog: openChangeLogDialog,
    onEditTrial: openTrialDialog,
    onCancel: openCancelDialog,
  };

  const subscriptions = data?.subscriptions ?? [];
  const derived = useMemo(() => {
    const chains = buildChains(subscriptions);
    const personal = chains.filter(c => getScope(c.tail).type === 'personal');
    const organization = chains.filter(c => getScope(c.tail).type === 'organization');
    const personalActive = personal.filter(c => c.tail.status !== 'canceled').length;
    const orgActive = organization.filter(c => c.tail.status !== 'canceled').length;
    return {
      personalChains: personal,
      organizationChains: organization,
      personalActive,
      personalCanceled: personal.length - personalActive,
      orgActive,
      orgCanceled: organization.length - orgActive,
    };
  }, [subscriptions]);

  if (isLoading) {
    return (
      <Card className="lg:col-span-4">
        <CardHeader>
          <CardTitle>KiloClaw</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card className="lg:col-span-4">
        <CardHeader>
          <CardTitle>KiloClaw</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-400">Failed to load KiloClaw state</p>
        </CardContent>
      </Card>
    );
  }

  const effective = subscriptions.find(s => s.id === data.effectiveSubscriptionId) ?? null;
  const pastDueBannerSubId = effective?.status === 'past_due' ? effective.id : null;

  const {
    personalChains,
    organizationChains,
    personalActive,
    personalCanceled,
    orgActive,
    orgCanceled,
  } = derived;

  const totalActive = personalActive + orgActive;
  const totalInactive = personalCanceled + orgCanceled;
  const countLabel =
    subscriptions.length === 0
      ? 'No subscriptions'
      : `${totalActive} active · ${totalInactive} inactive`;

  const hasOrgSubs = organizationChains.length > 0;
  const cancelingSubscription = subscriptions.find(s => s.id === cancelSubscriptionId) ?? null;

  return (
    <>
      <Card className="lg:col-span-4">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>KiloClaw</CardTitle>
              <CardDescription>{countLabel}</CardDescription>
            </div>
            {data.activeInstanceId && !subscriptions.some(s => s.instance) ? (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/admin/kiloclaw/${data.activeInstanceId}`}>
                  <ExternalLink className="mr-1 h-3 w-3" />
                  View Instance
                </Link>
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {data.needsSupportReview ? (
            <div className="rounded-lg border border-yellow-500/40 bg-yellow-950/20 p-4">
              <h4 className="text-sm font-medium text-yellow-300">
                Billing state needs support review
              </h4>
              <p className="mt-1 text-sm text-yellow-100/80">
                Current personal subscription rows could not be resolved automatically. Inspect the
                rows below before making changes.
              </p>
              {data.billingStateError ? (
                <p className="text-muted-foreground mt-2 break-words font-mono text-xs">
                  {data.billingStateError}
                </p>
              ) : null}
            </div>
          ) : null}

          {subscriptions.length > 0 ? <SummaryStrip state={data} effective={effective} /> : null}

          <EarlyAccessRow userId={userId} initialValue={data.kiloclawEarlyAccess} />

          {effective?.status === 'past_due' ? <PastDueBanner sub={effective} /> : null}

          {subscriptions.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This user does not have any KiloClaw subscription rows.
            </p>
          ) : (
            <div className="space-y-6">
              <SubscriptionsSection
                title="Personal subscriptions"
                description="Personal subscriptions affect the Personal access state above."
                chains={personalChains}
                effectiveSubscriptionId={data.effectiveSubscriptionId}
                expandedHistory={expandedHistory}
                toggleHistory={toggleHistory}
                hideInactive={hideInactivePersonal}
                onHideInactiveChange={setHideInactivePersonal}
                emptyMessage="No personal subscriptions."
                pastDueBannerSubId={pastDueBannerSubId}
                actions={actions}
              />

              {hasOrgSubs ? (
                <SubscriptionsSection
                  title="Organization subscriptions"
                  description="Organization-scoped subscriptions are listed separately and do not grant personal access."
                  chains={organizationChains}
                  effectiveSubscriptionId={data.effectiveSubscriptionId}
                  expandedHistory={expandedHistory}
                  toggleHistory={toggleHistory}
                  hideInactive={hideInactiveOrg}
                  onHideInactiveChange={setHideInactiveOrg}
                  emptyMessage="No organization subscriptions."
                  pastDueBannerSubId={pastDueBannerSubId}
                  actions={actions}
                />
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Trial edit / reset dialog */}
      <Dialog open={trialDialogOpen} onOpenChange={setTrialDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {trialSubscription?.status === 'canceled'
                ? 'Reset KiloClaw Trial'
                : 'Edit KiloClaw Trial End Date'}
            </DialogTitle>
            <DialogDescription>
              {trialSubscription?.status === 'canceled'
                ? 'Reset this canceled subscription to a new trial. This will restore access, clear suspension state, and attempt to restart the instance.'
                : "Set the day this user's KiloClaw trial ends. The trial will end at the end of the selected day."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Label htmlFor="kiloclaw-trial-end-date">Trial End Date</Label>
            <Input
              id="kiloclaw-trial-end-date"
              type="date"
              value={selectedDate}
              onChange={event => setSelectedDate(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTrialDialogOpen(false)}
              disabled={updateTrialEndAt.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleTrialSave}
              disabled={updateTrialEndAt.isPending || !selectedDate}
            >
              {updateTrialEndAt.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel subscription dialog */}
      <Dialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {cancelingSubscription?.status === 'trialing'
                ? 'Cancel KiloClaw Trial'
                : 'Cancel KiloClaw Subscription'}
            </DialogTitle>
            <DialogDescription>
              {cancelingSubscription?.status === 'trialing'
                ? 'This will immediately cancel the trial for this user. The trial end date will be set to now and access will be revoked.'
                : cancelingSubscription?.stripe_subscription_id
                  ? 'This will cancel the subscription for this user. No refund will be issued. This is a Stripe-funded subscription — Stripe will be updated.'
                  : 'This will cancel the subscription for this user. No refund will be issued. This is a credit-funded subscription — only the local database will be updated.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <Label>Cancellation timing</Label>
            {cancelingSubscription?.status === 'trialing' ? (
              <p className="text-muted-foreground text-xs">
                Trial subscriptions can only be canceled immediately. Access ends now. The lifecycle
                will suspend/stop the instance on its next run.
              </p>
            ) : cancelingSubscription?.status === 'past_due' ? (
              <p className="text-muted-foreground text-xs">
                Past-due subscriptions can only be canceled immediately. No refund. Local access
                ends now. The lifecycle will suspend/stop the instance on its next run.
              </p>
            ) : (
              <>
                <RadioButtonGroup
                  options={[
                    { value: 'period_end', label: 'At period end' },
                    { value: 'immediate', label: 'Immediately' },
                  ]}
                  value={cancelMode}
                  onChange={v => {
                    if (isCancelMode(v)) setCancelMode(v);
                  }}
                />
                <p className="text-muted-foreground text-xs">
                  {cancelMode === 'period_end'
                    ? 'No refund. The user keeps access until the current billing period ends.'
                    : 'No refund. Local access ends now. The lifecycle will suspend/stop the instance on its next run.'}
                </p>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCancelDialogOpen(false)}
              disabled={cancelSubscription.isPending}
            >
              Back
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancelConfirm}
              disabled={cancelSubscription.isPending}
            >
              {cancelSubscription.isPending
                ? 'Canceling...'
                : cancelingSubscription?.status === 'trialing'
                  ? 'Cancel Trial'
                  : cancelMode === 'immediate'
                    ? 'Cancel Immediately'
                    : 'Cancel at Period End'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change log dialog */}
      <Dialog
        open={Boolean(changeLogSubscriptionId)}
        onOpenChange={open => !open && closeChangeLogDialog()}
      >
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>KiloClaw Subscription Change Log</DialogTitle>
            <DialogDescription>
              Latest 50 change log entries for subscription{' '}
              <span className="font-mono">
                {changeLogSubscription?.id ?? changeLogSubscriptionId}
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-auto py-2">
            {changeLogsQuery.isLoading ? (
              <p className="text-muted-foreground text-sm">Loading change log...</p>
            ) : changeLogsQuery.error ? (
              <p className="text-sm text-red-400">Failed to load change log</p>
            ) : !changeLogsQuery.data || changeLogsQuery.data.changeLogs.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No change log entries for this subscription.
              </p>
            ) : (
              <div className="space-y-3">
                {changeLogsQuery.data.changeLogs.map(changeLog => (
                  <div key={changeLog.id} className="rounded-md border bg-muted/20 p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {changeLog.action}
                      </Badge>
                      <span className="text-muted-foreground text-xs">
                        {formatDate(changeLog.created_at)}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {changeLog.actor_type}:{' '}
                        <span className="font-mono">{changeLog.actor_id}</span>
                      </span>
                      {changeLog.reason ? (
                        <span className="text-muted-foreground text-xs">
                          reason: <span className="font-mono">{changeLog.reason}</span>
                        </span>
                      ) : null}
                    </div>
                    <div className="grid gap-2 text-xs md:grid-cols-2">
                      <details className="rounded border bg-background/60 p-2">
                        <summary className="cursor-pointer font-medium">Before</summary>
                        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
                          {formatJsonSummary(changeLog.before_state)}
                        </pre>
                      </details>
                      <details className="rounded border bg-background/60 p-2">
                        <summary className="cursor-pointer font-medium">After</summary>
                        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
                          {formatJsonSummary(changeLog.after_state)}
                        </pre>
                      </details>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeChangeLogDialog}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

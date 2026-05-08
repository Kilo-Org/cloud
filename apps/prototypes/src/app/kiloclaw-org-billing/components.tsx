/**
 * Presentational variants of every component proposed in
 * `.plans/org-kiloclaw-billing-ui.md`. No tRPC, no hooks beyond local state.
 *
 * Each component takes a fully-resolved status / preflight / row prop so the
 * prototype page can render every variant flat for design review.
 */

'use client';

import { forwardRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Ban,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cpu,
  CreditCard,
  ExternalLink,
  FileText,
  KeyRound,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  Receipt,
  Search,
  Settings,
  ShieldOff,
  Sparkles,
  Trash2,
  TriangleAlert,
  User,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import KiloCrabIcon from '@/components/KiloCrabIcon';
import { Banner } from '@/components/shared/Banner';
import {
  type AdminBillingStatus,
  type AssociatedUser,
  type CreditBillingEntry,
  type KiloAdminChangeLogEntry,
  type KiloAdminKiloclawInstanceRow,
  type KiloAdminKiloclawStats,
  type KiloAdminOrgSupportSummary,
  type KiloAdminUserSupportSummary,
  type KiloClawOrgSubscriptionRow,
  type MemberBillingStatus,
  type OrgBillingOperationalState,
  type OrgBillingStatus,
  type OrgKiloclawHealthSummary,
  type OrgProvisionPreflight,
  formatDate,
  formatMicrodollars,
} from './mock-data';

function pluralizeDays(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

const Link = forwardRef<
  HTMLAnchorElement,
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string }
>(function PrototypeLink({ href, onClick, ...props }, ref) {
  return (
    <a
      ref={ref}
      href={href.startsWith('#') ? href : '#'}
      data-prototype-href={href}
      onClick={event => {
        onClick?.(event);
        if (!event.defaultPrevented && !href.startsWith('#')) event.preventDefault();
      }}
      {...props}
    />
  );
});

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

export function StatusBadge({ kind }: { kind: OrgBillingOperationalState['kind'] | 'canceled' }) {
  // Status palette follows DESIGN.md and the in-repo shadcn `beta`/`new` badge
  // pattern: `bg-{c}-500/10 text-{c}-400 ring-1 ring-{c}-500/20 border-transparent`.
  const styles: Record<typeof kind, string> = {
    available: 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20 border-transparent',
    trialing: 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20 border-transparent',
    past_due: 'bg-yellow-500/10 text-yellow-400 ring-1 ring-yellow-500/20 border-transparent',
    canceling_at_period_end:
      'bg-yellow-500/10 text-yellow-400 ring-1 ring-yellow-500/20 border-transparent',
    blocked_parent_entitlement:
      'bg-red-500/10 text-red-400 ring-1 ring-red-500/20 border-transparent',
    blocked_opt_out: 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20 border-transparent',
    canceled: 'bg-muted text-muted-foreground ring-1 ring-border border-transparent',
  };
  const labels: Record<typeof kind, string> = {
    available: 'Active',
    trialing: 'Trial',
    past_due: 'Past due',
    canceling_at_period_end: 'Canceling',
    blocked_parent_entitlement: 'Blocked',
    blocked_opt_out: 'Disabled',
    canceled: 'Canceled',
  };
  return (
    <Badge variant="outline" className={cn('rounded-full px-2.5 py-1 text-[11px]', styles[kind])}>
      {labels[kind]}
    </Badge>
  );
}

function CardKV({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs uppercase tracking-wide">{label}</p>
      <div className={cn('text-sm font-medium', mono && 'font-mono tabular-nums')}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page chrome helpers (for non-claw-layout pages: Wave A detail, Settings)
// ---------------------------------------------------------------------------

function PageHeader({
  backHref,
  backLabel,
  title,
  statusBadge,
  actions,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  statusBadge?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <Link
        href={backHref}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        {backLabel}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{title}</h1>
        {statusBadge}
        {actions && <div className="ml-auto">{actions}</div>}
      </div>
    </div>
  );
}

function NoteCallout({
  tone,
  copy,
}: {
  tone: 'emerald' | 'yellow' | 'red' | 'blue';
  copy: string;
}) {
  // Large tonal surfaces use a quieter shade than chips. The chip pattern
  // (`/10 bg + -400 text + ring-/20`) is calibrated for ~16px badges; on a
  // full-width panel the same intensity reads as an alert. Drop bg to /5,
  // border to /20, text to -300.
  const styles: Record<typeof tone, string> = {
    emerald: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300',
    yellow: 'border-yellow-500/20 bg-yellow-500/5 text-yellow-300',
    red: 'border-red-500/20 bg-red-500/5 text-red-300',
    blue: 'border-blue-500/20 bg-blue-500/5 text-blue-300',
  };
  return (
    <div className={cn('rounded-xl border p-4 text-sm', styles[tone])}>
      <p>{copy}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Claw layout chrome stub
// ---------------------------------------------------------------------------
//
// In production, the claw layout's sidebar (org/workspace switcher + KiloClaw
// nav: Chat / Subscription / Settings) and topbar (section icon + title via
// SetPageTitle) provide the chrome. The page itself just renders cards.
// This stub fakes the topbar so the prototype matches the production shape.

function ClawTopbarStub({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <div className="border-border bg-background flex h-14 items-center gap-3 border-b px-4 md:px-6">
      <Icon className="text-muted-foreground h-4 w-4" />
      <span className="text-foreground text-sm font-medium">{title}</span>
    </div>
  );
}

function ClawPageContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
      {children}
    </div>
  );
}

function ClawLayoutFrame({
  topbarTitle,
  topbarIcon,
  children,
}: {
  topbarTitle: string;
  topbarIcon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-background overflow-hidden rounded-xl border">
      <ClawTopbarStub icon={topbarIcon} title={topbarTitle} />
      <ClawPageContainer>{children}</ClawPageContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar + dashboard navigation mocks
// ---------------------------------------------------------------------------
//
// PR 1 adds a "Subscription" entry to the KiloClaw sub-nav. PR 4a renames the
// org-level "Providers and models" item to "Settings" (with the existing tab
// hosted inside) and adds a second dashboard CTA. These surfaces aren't
// represented anywhere else in the prototype — the rest of the catalog only
// renders the page chrome that lives BELOW the sidebar/dashboard. These two
// stubs make the navigation deltas visible without rebuilding the full
// production sidebar.

function SidebarNavRow({
  icon: Icon,
  label,
  indent,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  indent?: boolean;
}) {
  return (
    <div
      className={cn(
        'text-muted-foreground flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        indent && 'ml-4'
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      <span className="flex-1 truncate">{label}</span>
    </div>
  );
}

export function SidebarPreview({ role = 'admin' }: { role?: 'admin' | 'member' }) {
  const canManageOrganization = role === 'admin';

  return (
    <div className="bg-muted/10 max-w-[280px] rounded-xl border p-3">
      <p className="text-muted-foreground px-2 pb-2 text-xs uppercase tracking-wide">Acme Inc.</p>
      <div className="space-y-0.5">
        <SidebarNavRow icon={LayoutDashboard} label="Dashboard" />
        {canManageOrganization && <SidebarNavRow icon={Receipt} label="Subscriptions" />}
        {canManageOrganization && <SidebarNavRow icon={Settings} label="Settings" />}
      </div>
      <div className="border-border/60 mt-3 space-y-0.5 border-t pt-3">
        <div className="flex items-center gap-2 px-2 py-1">
          <KiloCrabIcon className="text-foreground h-4 w-4" />
          <span className="text-muted-foreground text-xs uppercase tracking-wide">KiloClaw</span>
        </div>
        <SidebarNavRow icon={MessageSquare} label="Chat" indent />
        <SidebarNavRow icon={CreditCard} label="Subscription" indent />
        <SidebarNavRow icon={Settings} label="Settings" indent />
      </div>
    </div>
  );
}

export function DashboardCTAsPreview() {
  return (
    <div className="flex flex-wrap gap-3">
      <Button variant="outline" asChild>
        <Link href="/organizations/mock-org/settings?tab=providers-and-models">
          <Cpu aria-hidden />
          Models & Providers
        </Link>
      </Button>
      <Button variant="outline" asChild>
        <Link href="/organizations/mock-org/settings?tab=kiloclaw">
          <Settings aria-hidden />
          KiloClaw Settings
        </Link>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR 1 — OrgSubscriptionPage (admin + member view)
// ---------------------------------------------------------------------------
//
// Mounted at /organizations/[id]/claw/subscription, inside the claw layout.
// The layout provides the sidebar (org/workspace switcher + KiloClaw nav:
// Chat / Subscription / Settings) and topbar ("Subscription" via
// SetPageTitle). The page itself renders a single subscription card
// directly into the content area — no back-link, no page-level H1.

export function OrgSubscriptionPagePreview({ status }: { status: OrgBillingStatus }) {
  return (
    <ClawLayoutFrame topbarTitle="Subscription" topbarIcon={CreditCard}>
      {status.role === 'admin' ? (
        <AdminOrgSubscriptionView status={status} />
      ) : (
        <MemberOrgSubscriptionView status={status} />
      )}
    </ClawLayoutFrame>
  );
}

function subscriptionToneFor(
  operational: OrgBillingOperationalState
): 'neutral' | 'info' | 'warning' | 'danger' {
  switch (operational.kind) {
    case 'past_due':
    case 'canceling_at_period_end':
      return 'warning';
    case 'blocked_parent_entitlement':
    case 'blocked_opt_out':
      return 'danger';
    case 'trialing':
      return 'info';
    default:
      return 'neutral';
  }
}

// Status text classes for inline copy inside subscription cards. We rely on
// these (plus the StatusBadge) to communicate state; the card surface itself
// stays neutral so a stack of variants doesn't read as a wall of colored
// surfaces. DESIGN.md: "Use Kilo yellow-green for exactly one primary action
// per surface" — status colors are scarce signals, not surface fills.
function toneTextClasses(tone: 'neutral' | 'info' | 'warning' | 'danger'): string {
  switch (tone) {
    case 'info':
      return 'text-blue-400';
    case 'warning':
      return 'text-yellow-400';
    case 'danger':
      return 'text-red-400';
    default:
      return 'text-muted-foreground';
  }
}

function adminStatusCopy(operational: OrgBillingOperationalState): string | null {
  switch (operational.kind) {
    case 'past_due':
      return 'Renewal failed. Top up organization credits to keep KiloClaw running.';
    case 'canceling_at_period_end':
      return `Instance destroyed. Subscription ends on ${formatDate(operational.endsAt)}.`;
    case 'blocked_parent_entitlement':
      return operational.reason === 'org_subscription_ended'
        ? 'Organization subscription ended. KiloClaw is paused for the entire organization.'
        : 'Organization trial ended without converting to a paid plan. KiloClaw is paused for the entire organization.';
    case 'blocked_opt_out':
      return 'KiloClaw is disabled for this organization.';
    case 'trialing':
      return `Free until ${formatDate(operational.endsAt)}. Renews from organization credits at trial end.`;
    default:
      return null;
  }
}

function adminStatusLineFor(operational: OrgBillingOperationalState): {
  label: string;
  className: string;
} {
  switch (operational.kind) {
    case 'available':
      return { label: 'Active', className: 'text-emerald-400' };
    case 'trialing':
      return {
        label:
          operational.trialKind === '30day_launch'
            ? `Trialing · 30-day launch trial · ${pluralizeDays(operational.daysRemaining)} remaining`
            : `Trialing · 7-day trial · ${pluralizeDays(operational.daysRemaining)} remaining`,
        className: 'text-blue-400',
      };
    case 'past_due':
      return {
        label: operational.suspendedAt
          ? `Past due · suspended on ${formatDate(operational.suspendedAt)}`
          : 'Past due',
        className: 'text-yellow-400',
      };
    case 'canceling_at_period_end':
      return {
        label: `Cancels on ${formatDate(operational.endsAt)}`,
        className: 'text-yellow-400',
      };
    case 'blocked_parent_entitlement':
      return {
        label:
          operational.reason === 'org_subscription_ended'
            ? 'Blocked: organization subscription ended'
            : 'Blocked: organization trial expired',
        className: 'text-red-400',
      };
    case 'blocked_opt_out':
      return { label: 'Disabled by organization opt-out', className: 'text-red-400' };
  }
}

function trialTypeCopy(trialKind: '30day_launch' | '7day_user'): string {
  // User-facing label. Internal taxonomy distinguishes a 30-day billing-launch
  // trial from a 7-day per-user trial; users only need the duration.
  return trialKind === '30day_launch' ? '30-day launch trial' : '7-day trial';
}

function AdminOrgSubscriptionView({ status }: { status: AdminBillingStatus }) {
  const { operational, subscription, org } = status;

  // Empty state — no subscription row, available
  if (operational.kind === 'available' && !subscription) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <div className="bg-muted flex h-12 w-12 items-center justify-center rounded-xl">
            <KiloCrabIcon className="text-foreground h-6 w-6" />
          </div>
          <div className="space-y-1">
            <p className="text-foreground text-sm font-medium">No KiloClaw subscription yet</p>
            <p className="text-muted-foreground text-sm">
              Anyone in your organization can provision an instance.
            </p>
          </div>
          <Button variant="default" className={KILO_PRIMARY_BUTTON_CLASS} asChild>
            <Link href="/organizations/mock-org/claw/new">
              Provision KiloClaw
              <ChevronRight />
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const tone = subscriptionToneFor(operational);
  const statusCopy = adminStatusCopy(operational);
  const statusLine = adminStatusLineFor(operational);
  const trialEndsAt = operational.kind === 'trialing' ? operational.endsAt : null;
  const renewalLabel = trialEndsAt ? 'Renews on' : 'Next billing';
  const renewalDate =
    trialEndsAt ?? subscription?.creditRenewalAt ?? subscription?.currentPeriodEnd;

  // Three vertical groups separate the subscription's facts by category and
  // give the eye a place to land:
  //   identity   plan, status
  //   billing    renewal date, renewal cost, trial type
  //   org-scope  associated user, org credit balance
  // The previous flat list gave each row identical visual weight; rhythm
  // (tight within group, breathing between) reads faster.
  const trialing = operational.kind === 'trialing';
  // No in-Card title row: the claw layout's topbar already says "Subscription"
  // directly above this Card. A second "Organization KiloClaw subscription"
  // heading would just repeat the page's reason for existing.
  return (
    <Card>
      <div className="flex flex-col gap-5 p-6">
        <dl className="text-muted-foreground grid gap-4 text-sm sm:grid-cols-2">
          <SubFact label="Plan">
            <span className="text-foreground">Standard ($49/mo)</span>
          </SubFact>
          <SubFact label="Status">
            <span className={statusLine.className}>{statusLine.label}</span>
          </SubFact>
          {renewalDate && (
            <SubFact label={renewalLabel}>
              <span className="text-foreground font-mono tabular-nums">
                {formatDate(renewalDate)}
              </span>
            </SubFact>
          )}
          {subscription?.renewalCostMicrodollars != null && (
            <SubFact label="Renewal cost">
              <span className="text-foreground">
                <span className="font-mono tabular-nums">
                  {formatMicrodollars(subscription.renewalCostMicrodollars)}
                </span>{' '}
                from organization credits
              </span>
            </SubFact>
          )}
          {trialing && (
            <SubFact label="Trial type">
              <span className="text-foreground">{trialTypeCopy(operational.trialKind)}</span>
            </SubFact>
          )}
          {subscription?.associatedUserDisplayName && (
            <SubFact label="Associated user">
              <span className="text-foreground">{subscription.associatedUserDisplayName}</span>
            </SubFact>
          )}
          <SubFact label="Org credit balance" className="sm:col-span-2">
            <span className="text-foreground font-mono tabular-nums">
              {formatMicrodollars(org.creditBalanceMicrodollars)}
            </span>
          </SubFact>
        </dl>

        {statusCopy && <p className={cn('text-sm', toneTextClasses(tone))}>{statusCopy}</p>}

        {operational.kind === 'past_due' && (
          <div>
            <Button variant="default" className={KILO_PRIMARY_BUTTON_CLASS} asChild>
              <Link href="/organizations/mock-org/payment-details">
                <CreditCard /> Top up organization credits
              </Link>
            </Button>
          </div>
        )}
        {operational.kind === 'blocked_parent_entitlement' && (
          <div>
            <Button variant="outline" asChild>
              <Link href="/organizations/mock-org/subscription">
                Manage organization subscription
                <ExternalLink className="!size-3.5" />
              </Link>
            </Button>
          </div>
        )}
        {operational.kind === 'blocked_opt_out' && (
          <div>
            <Button variant="outline" asChild>
              <Link href="/organizations/mock-org/settings?tab=kiloclaw">
                Manage in organization settings
                <ExternalLink className="!size-3.5" />
              </Link>
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function SubFact({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('space-y-0.5', className)}>
      <dt className="text-muted-foreground text-xs uppercase tracking-wide">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function MemberOrgSubscriptionView({ status }: { status: MemberBillingStatus }) {
  const { operational } = status;
  const tone = subscriptionToneFor(operational);

  const memberCopy = (() => {
    switch (operational.kind) {
      case 'available':
        return { title: 'Available', body: 'Your KiloClaw is active.' };
      case 'trialing':
        return {
          title: 'Free trial',
          body: `${pluralizeDays(operational.daysRemaining)} remaining (${trialTypeCopy(operational.trialKind)}). Renews from organization credits at trial end.`,
        };
      case 'past_due':
        return {
          title: 'Past due',
          body: 'Ask a billing administrator to top up organization credits.',
        };
      case 'canceling_at_period_end':
        return {
          title: 'Subscription ending',
          body: `The instance has been destroyed. Subscription ends on ${formatDate(operational.endsAt)}.`,
        };
      case 'blocked_parent_entitlement':
        return {
          title: 'Organization subscription is paused',
          body: 'Ask an owner or billing manager to reactivate the organization subscription.',
        };
      case 'blocked_opt_out':
        return {
          title: 'KiloClaw is disabled',
          body: 'Your administrator has disabled KiloClaw for this organization.',
        };
    }
  })();

  // Same reasoning as the admin view: the topbar already labels this page,
  // so the Card jumps straight to the member-facing status copy.
  return (
    <Card>
      <div className="p-6">
        <p className="text-foreground text-sm font-medium">{memberCopy.title}</p>
        <p className={cn('mt-1 text-sm', toneTextClasses(tone))}>{memberCopy.body}</p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// PR 2 — Banner + lock dialog + destroy confirm
// ---------------------------------------------------------------------------

// Banner CTAs use a subtle outline style: transparent background, low-alpha
// foreground border, foreground text, subtle hover wash. The banner's tonal
// background carries the urgency; the button is the discoverable affordance,
// not the loudest pixel on the page.
//
// Why not Kilo brand-primary here? A bright yellow CTA on a yellow trial
// banner produces a hue collision (button merges with banner accent). On red
// or blue banners it competes with the banner's own communication. DESIGN.md
// wants brand-primary scarce; the subscription card and dialog CTAs (which
// sit on neutral surfaces and ARE the page's primary action) keep it.
//
// Why not the production default (saturated category fill, e.g.
// `bg-amber-500`)? DESIGN.md "Blue Is Inline Rule" prohibits blue and other
// status colors as button backgrounds. Production banner-button migration is
// a separate piece of work; this prototype demonstrates the target shape.
const KILO_PRIMARY_BUTTON_CLASS =
  'bg-brand-primary text-primary-foreground shadow-none hover:bg-brand-primary/90 focus-visible:ring-brand-primary/40';

const BANNER_BUTTON_CLASS =
  'bg-transparent border border-foreground/20 text-foreground shadow-none hover:bg-foreground/10 hover:text-foreground';

function SubtleBannerButton({
  href,
  onClick,
  children,
  className,
}: {
  href?: string;
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Banner.Button href={href} onClick={onClick} className={cn(BANNER_BUTTON_CLASS, className)}>
      {children}
    </Banner.Button>
  );
}

export function OrgBillingBannerPreview({ status }: { status: OrgBillingStatus }) {
  const { operational } = status;
  const role = status.role;

  switch (operational.kind) {
    case 'trialing': {
      const days = operational.daysRemaining;
      const sub =
        days === 0
          ? 'expires_today'
          : days === 1
            ? 'ending_very_soon'
            : days <= 3
              ? 'ending_soon'
              : 'active';
      const trialLabel = trialTypeCopy(operational.trialKind);
      if (sub === 'active') {
        return (
          <Banner color="blue">
            <Banner.Icon>
              <Clock />
            </Banner.Icon>
            <Banner.Content>
              <Banner.Title>{`Free trial · ${pluralizeDays(days)} remaining`}</Banner.Title>
              <Banner.Description>{`${trialLabel}. Renews from organization credits on ${formatDate(operational.endsAt)}.`}</Banner.Description>
            </Banner.Content>
            <SubtleBannerButton href="/organizations/mock-org/claw/subscription">
              Manage
            </SubtleBannerButton>
          </Banner>
        );
      }
      if (sub === 'ending_soon') {
        return (
          <Banner color="yellow">
            <Banner.Icon>
              <AlertCircle />
            </Banner.Icon>
            <Banner.Content>
              <Banner.Title>{`Trial ending in ${pluralizeDays(days)}`}</Banner.Title>
              <Banner.Description>
                Renewal cost will deduct from organization credits on{' '}
                {formatDate(operational.endsAt)}.
              </Banner.Description>
            </Banner.Content>
            <SubtleBannerButton href="/organizations/mock-org/claw/subscription">
              Manage
            </SubtleBannerButton>
          </Banner>
        );
      }
      if (sub === 'ending_very_soon') {
        return (
          <Banner color="red">
            <Banner.Icon>
              <AlertCircle />
            </Banner.Icon>
            <Banner.Content>
              <Banner.Title>Trial ends tomorrow</Banner.Title>
              <Banner.Description>
                Renewal will deduct from organization credits on {formatDate(operational.endsAt)}.
              </Banner.Description>
            </Banner.Content>
            <SubtleBannerButton href="/organizations/mock-org/claw/subscription">
              Manage
            </SubtleBannerButton>
          </Banner>
        );
      }
      return (
        <Banner color="red">
          <Banner.Icon>
            <AlertTriangle />
          </Banner.Icon>
          <Banner.Content>
            <Banner.Title>Trial ends today</Banner.Title>
            <Banner.Description>
              Your KiloClaw will renew from organization credits at end of day.
            </Banner.Description>
          </Banner.Content>
          <SubtleBannerButton href="/organizations/mock-org/claw/subscription">
            Manage
          </SubtleBannerButton>
        </Banner>
      );
    }
    case 'past_due':
      if (role === 'admin') {
        return (
          <Banner color="red">
            <Banner.Icon>
              <CreditCard />
            </Banner.Icon>
            <Banner.Content>
              <Banner.Title>Renewal failed</Banner.Title>
              <Banner.Description>
                Top up organization credits to keep KiloClaw running.
              </Banner.Description>
            </Banner.Content>
            <SubtleBannerButton href="/organizations/mock-org/payment-details">
              Top up credits
            </SubtleBannerButton>
          </Banner>
        );
      }
      return (
        <Banner color="red">
          <Banner.Icon>
            <AlertTriangle />
          </Banner.Icon>
          <Banner.Content>
            <Banner.Title>Past due</Banner.Title>
            <Banner.Description>
              Ask a billing administrator to top up organization credits.
            </Banner.Description>
          </Banner.Content>
        </Banner>
      );
    case 'canceling_at_period_end':
      return (
        <Banner color="yellow">
          <Banner.Icon>
            <AlertCircle />
          </Banner.Icon>
          <Banner.Content>
            <Banner.Title>{`Subscription ends on ${formatDate(operational.endsAt)}`}</Banner.Title>
            <Banner.Description>The instance has been destroyed.</Banner.Description>
          </Banner.Content>
        </Banner>
      );
    case 'blocked_parent_entitlement':
      return (
        <Banner color="red">
          <Banner.Icon>
            <Ban />
          </Banner.Icon>
          <Banner.Content>
            <Banner.Title>Organization subscription is paused</Banner.Title>
            <Banner.Description>
              {operational.reason === 'org_subscription_ended'
                ? 'Your KiloClaw is unavailable until the organization subscription is reactivated.'
                : 'The organization trial ended without converting to a paid plan.'}
            </Banner.Description>
          </Banner.Content>
          {role === 'admin' && (
            <SubtleBannerButton href="/organizations/mock-org/subscription">
              Manage
            </SubtleBannerButton>
          )}
        </Banner>
      );
    case 'blocked_opt_out':
      return (
        <Banner color="red">
          <Banner.Icon>
            <ShieldOff />
          </Banner.Icon>
          <Banner.Content>
            <Banner.Title>KiloClaw is disabled</Banner.Title>
            <Banner.Description>
              {role === 'admin'
                ? 'Re-enable in organization settings.'
                : 'Your administrator turned KiloClaw off for this organization.'}
            </Banner.Description>
          </Banner.Content>
          {role === 'admin' && (
            <SubtleBannerButton href="/organizations/mock-org/settings?tab=kiloclaw">
              Settings
            </SubtleBannerButton>
          )}
        </Banner>
      );
    case 'available':
    default:
      return null;
  }
}

export function OrgAccessLockedDialogPreview({ status }: { status: OrgBillingStatus }) {
  const { operational } = status;
  const role = status.role;

  const content = (() => {
    switch (operational.kind) {
      case 'past_due':
        if (operational.suspendedAt === null) return null;
        return {
          icon: CreditCard,
          title: 'KiloClaw is suspended',
          description:
            role === 'admin'
              ? 'Renewal failed and the grace period has elapsed. Top up organization credits to resume.'
              : 'Renewal failed. Ask a billing administrator to top up organization credits.',
          cta:
            role === 'admin'
              ? { label: 'Top up credits', href: '/organizations/mock-org/payment-details' }
              : null,
        };
      case 'blocked_parent_entitlement':
        return {
          icon: Ban,
          title: 'Organization subscription is paused',
          description:
            operational.reason === 'org_subscription_ended'
              ? 'Your KiloClaw is unavailable until the organization subscription is reactivated.'
              : 'The organization trial ended without converting to a paid plan.',
          cta:
            role === 'admin'
              ? { label: 'Manage subscription', href: '/organizations/mock-org/subscription' }
              : null,
        };
      case 'blocked_opt_out':
        return {
          icon: ShieldOff,
          title: 'KiloClaw is disabled',
          description:
            role === 'admin'
              ? 'You turned KiloClaw off for this organization. Re-enable in settings.'
              : 'Your administrator turned KiloClaw off for this organization.',
          cta:
            role === 'admin'
              ? { label: 'Open settings', href: '/organizations/mock-org/settings?tab=kiloclaw' }
              : null,
        };
      default:
        return null;
    }
  })();

  if (!content) return null;
  const Icon = content.icon;

  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6">
      <p className="text-muted-foreground mb-3 text-xs uppercase tracking-wide">
        Lock dialog (modal preview, inlined)
      </p>
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-red-500/20">
          <Icon className="h-8 w-8 text-red-400" />
        </div>
        <div className="space-y-1">
          <h3 className="text-xl font-bold text-red-400">{content.title}</h3>
          <p className="text-muted-foreground text-sm">{content.description}</p>
        </div>
        <div className="flex w-full max-w-sm flex-col gap-2">
          {content.cta && (
            <Button variant="default" className={KILO_PRIMARY_BUTTON_CLASS} asChild>
              <Link href={content.cta.href}>{content.cta.label}</Link>
            </Button>
          )}
          <Button variant="link" className="text-muted-foreground">
            Go to organization dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}

export function OrgDestroyConfirmDialogPreview({
  isLaunchBackfill,
  currentPeriodEnd,
}: {
  isLaunchBackfill: boolean;
  currentPeriodEnd: string;
}) {
  return (
    <div className="bg-card mx-auto max-w-md rounded-xl border p-6 shadow-lg">
      <p className="text-muted-foreground mb-3 text-xs uppercase tracking-wide">
        Destroy confirm dialog (preview)
      </p>
      <h3 className="mb-2 text-lg font-semibold">Destroy organization KiloClaw?</h3>
      <p className="text-muted-foreground mb-4 text-sm">
        This tears down the running instance immediately and stops the subscription at the end of
        the current period (<span className="font-mono">{formatDate(currentPeriodEnd)}</span>).
      </p>
      <ul className="text-muted-foreground mb-4 list-disc space-y-1.5 pl-5 text-sm">
        <li>Credits already deducted for this period are not refunded.</li>
        <li>You cannot reactivate this instance after destroying it.</li>
        {isLaunchBackfill && (
          <li>
            Your instance is on the 30-day launch trial. Destroying ends the trial early, so
            re-creating an instance will deduct from organization credits immediately.
          </li>
        )}
      </ul>
      <div className="flex justify-end gap-2">
        <Button variant="outline">Cancel</Button>
        <Button
          variant="destructive"
          className="bg-red-500 text-white hover:bg-red-500/90 focus-visible:ring-red-500/40"
        >
          <Trash2 className="size-4" /> Destroy
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR 3 — Provisioning preflight blocks
// ---------------------------------------------------------------------------

export function OrgProvisionPreflightPreview({ preflight }: { preflight: OrgProvisionPreflight }) {
  const role = preflight.role;

  switch (preflight.kind) {
    case 'allowed':
      return (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KiloCrabIcon className="text-foreground h-5 w-5" />
              Provision KiloClaw
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
              {role === 'admin' ? (
                <p className="text-sm text-blue-300">
                  {preflight.trialEligible
                    ? `Free for 7 days, then ${formatMicrodollars(preflight.firstPeriodCostMicrodollars)} from organization credits.`
                    : `${formatMicrodollars(preflight.firstPeriodCostMicrodollars)} from organization credits at provisioning.`}
                </p>
              ) : (
                <p className="text-sm text-blue-300">
                  {preflight.trialEligible
                    ? 'Free for 7 days, then renews from organization credits.'
                    : 'Renews from organization credits at provisioning.'}
                </p>
              )}
            </div>
            {/* Admin-only balance fact. Cost was already in the callout above;
             * showing it again as a CardKV is duplicate ink. The balance is
             * the only piece of context the callout doesn't carry. */}
            {role === 'admin' && (
              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wide">
                  Org credit balance
                </p>
                <p className="text-foreground font-mono tabular-nums">
                  {formatMicrodollars(preflight.orgCreditBalanceMicrodollars)}
                </p>
              </div>
            )}
            <Button variant="default" className={KILO_PRIMARY_BUTTON_CLASS}>
              Create instance
            </Button>
          </CardContent>
        </Card>
      );
    case 'blocked_parent_entitlement': {
      const reasonCopy = (() => {
        switch (preflight.reason) {
          case 'no_org_subscription':
            return 'Your organization does not have an active subscription.';
          case 'org_subscription_ended':
            return 'Your organization subscription has ended.';
          case 'org_trial_hard_expired':
            return 'Your organization trial ended without converting to a paid plan.';
        }
      })();
      return (
        <PreflightBlockCard
          icon={Ban}
          title="Provisioning blocked"
          description={`${reasonCopy} KiloClaw can only be provisioned while your organization has an active subscription.`}
          cta={
            role === 'admin'
              ? {
                  label: 'Manage organization subscription',
                  href: '/organizations/mock-org/subscription',
                }
              : null
          }
          memberHint={
            role === 'member'
              ? 'Ask an owner or billing manager to reactivate the organization subscription.'
              : null
          }
        />
      );
    }
    case 'blocked_opt_out':
      return (
        <PreflightBlockCard
          icon={ShieldOff}
          title="KiloClaw is disabled"
          description={
            role === 'admin'
              ? 'You disabled KiloClaw for this organization. Re-enable in settings to provision new instances.'
              : 'Your administrator has disabled KiloClaw for this organization.'
          }
          cta={
            role === 'admin'
              ? {
                  label: 'Manage in organization settings',
                  href: '/organizations/mock-org/settings?tab=kiloclaw',
                }
              : null
          }
        />
      );
    case 'blocked_existing_instance':
      return (
        <PreflightBlockCard
          icon={Sparkles}
          title="You already have a KiloClaw"
          description={`Each member can have one organization KiloClaw instance at a time. Your existing instance is "${preflight.existingInstanceName ?? preflight.existingInstanceId}".`}
          cta={{ label: 'Open existing instance', href: '/organizations/mock-org/claw/chat' }}
        />
      );
    case 'blocked_insufficient_credits':
      if (role === 'admin') {
        return (
          <PreflightBlockCard
            icon={CreditCard}
            title="Insufficient organization credits"
            description={`Provisioning requires ${formatMicrodollars(preflight.firstPeriodCostMicrodollars)} in organization credits. You have ${formatMicrodollars(preflight.orgCreditBalanceMicrodollars)} (shortfall ${formatMicrodollars(preflight.shortfallMicrodollars)}).`}
            cta={{
              label: 'Top up organization credits',
              href: '/organizations/mock-org/payment-details',
            }}
          />
        );
      }
      return (
        <PreflightBlockCard
          icon={CreditCard}
          title="Provisioning blocked"
          description="The organization does not have enough credits to provision KiloClaw."
          cta={null}
          memberHint="Ask a billing administrator to top up organization credits."
        />
      );
  }
}

function PreflightBlockCard({
  icon: Icon,
  title,
  description,
  cta,
  memberHint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  cta: { label: string; href: string } | null;
  memberHint?: string | null;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-4 p-6">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-red-500/20">
          <Icon className="h-6 w-6 text-red-400" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        {cta && (
          <Button variant="default" className={KILO_PRIMARY_BUTTON_CLASS} asChild>
            <Link href={cta.href}>
              {cta.label}
              <ChevronRight />
            </Link>
          </Button>
        )}
        {memberHint && <p className="text-muted-foreground text-sm">{memberHint}</p>}
      </CardContent>
    </Card>
  );
}

export function OrgProvisionPreflightLoading() {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-muted-foreground text-sm">Checking provisioning eligibility…</p>
      </CardContent>
    </Card>
  );
}

export function OrgProvisionPreflightError() {
  return (
    <Card className="border-red-500/30 bg-red-500/10">
      <CardContent className="flex items-start gap-3 p-6">
        <AlertTriangle className="text-red-400 mt-0.5 h-5 w-5" />
        <div className="space-y-1">
          <p className="font-semibold">Could not check eligibility</p>
          <p className="text-muted-foreground text-sm">
            Try refreshing. If the problem persists, contact support.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// PR 4a — Org Settings page restructure (tabs)
// PR 4b — KiloClaw tab content
// ---------------------------------------------------------------------------

export function OrgSettingsPagePreview({
  plan,
  optOut,
  onOptOutChange,
}: {
  plan: 'teams' | 'enterprise';
  optOut: boolean;
  onOptOutChange: (next: boolean) => void;
}) {
  const [settingsTab, setSettingsTab] = useState('providers-and-models');

  return (
    <div className="space-y-6">
      <PageHeader
        backHref="/organizations/mock-org"
        backLabel="Back to organization"
        title="Organization settings"
      />
      <Tabs value={settingsTab} onValueChange={setSettingsTab} className="space-y-6">
        <TabsList>
          <TabsTrigger value="providers-and-models">Providers and models</TabsTrigger>
          <TabsTrigger value="kiloclaw">KiloClaw</TabsTrigger>
        </TabsList>
        <TabsContent value="providers-and-models">
          <Card>
            <CardHeader>
              <CardTitle>Providers and models</CardTitle>
              <CardDescription>
                Configure which providers and models your organization can use.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">
                (Existing OrganizationProvidersAndModelsPage content renders here, unchanged.)
              </p>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="kiloclaw">
          <KiloClawTabPreview plan={plan} optOut={optOut} onOptOutChange={onOptOutChange} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PrototypeSwitch({
  checked,
  onCheckedChange,
  ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'focus-visible:ring-ring inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        checked ? 'bg-brand-primary' : 'bg-input'
      )}
    >
      <span
        className={cn(
          'bg-background block h-5 w-5 rounded-full shadow-lg transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0'
        )}
      />
    </button>
  );
}

export function KiloClawTabPreview({
  plan,
  optOut,
  onOptOutChange,
}: {
  plan: 'teams' | 'enterprise';
  optOut: boolean;
  onOptOutChange: (next: boolean) => void;
}) {
  const [showConfirm, setShowConfirm] = useState(false);

  if (plan !== 'enterprise') {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 p-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-yellow-500/10">
            <KeyRound className="h-6 w-6 text-yellow-400" />
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Enterprise feature</h2>
            <p className="text-muted-foreground text-sm">
              KiloClaw access controls are available on Enterprise plans. Contact sales to upgrade.
            </p>
          </div>
          <Button variant="default" className={KILO_PRIMARY_BUTTON_CLASS} asChild>
            <Link href="/contact-sales">Contact sales</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  function handleToggle(next: boolean) {
    if (next) {
      setShowConfirm(true);
    } else {
      onOptOutChange(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>KiloClaw access</CardTitle>
          <CardDescription>
            Control whether members of this organization can provision and use KiloClaw.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Setting row sits directly inside CardContent: nested cards (Card >
           * CardContent > rounded-xl border) are an absolute ban. Spacing and
           * the switch control's gravity carry the affordance. */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <p className="font-medium">Disable KiloClaw for this organization</p>
              <p className="text-muted-foreground text-sm">
                Blocks all members from accessing or provisioning org KiloClaw instances. Existing
                subscriptions remain in their current period and stop at period end.
              </p>
            </div>
            <PrototypeSwitch
              checked={optOut}
              onCheckedChange={handleToggle}
              ariaLabel="Disable KiloClaw"
            />
          </div>
        </CardContent>
      </Card>

      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disable KiloClaw for Acme Corp?</DialogTitle>
            <DialogDescription className="space-y-2 pt-2">
              <span>
                <span className="font-mono">3</span> members currently have running KiloClaw
                instances. Disabling will:
              </span>
            </DialogDescription>
          </DialogHeader>
          <ul className="text-muted-foreground -mt-2 list-disc space-y-1.5 pl-6 text-sm">
            <li>Block all members from accessing those instances immediately.</li>
            <li>Prevent any renewals for the current period.</li>
            <li>Block any new provisioning until you re-enable KiloClaw.</li>
          </ul>
          <p className="text-muted-foreground text-sm">
            Existing subscriptions remain in their current period and are not automatically
            canceled. Members will see a "disabled by your administrator" message in their KiloClaw
            view.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onOptOutChange(true);
                setShowConfirm(false);
              }}
            >
              Disable KiloClaw
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Wave A — OrgKiloClawDetail (admin observability page)
// ---------------------------------------------------------------------------

export function OrgKiloClawDetailPreview({
  row,
  history,
}: {
  row: KiloClawOrgSubscriptionRow;
  history: CreditBillingEntry[];
}) {
  const note = (() => {
    if (row.operationalKind === 'past_due')
      return {
        tone: 'yellow' as const,
        copy: 'Renewal failed. Top up organization credits to keep this instance running.',
      };
    if (row.cancelAtPeriodEnd)
      return {
        tone: 'yellow' as const,
        copy: `Subscription ends on ${formatDate(row.currentPeriodEnd)}.`,
      };
    if (row.operationalKind === 'blocked_parent_entitlement') {
      // Reason-specific copy mirrors PR 1 subscription-page rendering. Tone
      // is red because the instance is unreachable until the parent
      // entitlement is restored — admins need to act on the org-level
      // subscription, not on this instance.
      return {
        tone: 'red' as const,
        copy:
          row.blockingReason === 'org_trial_hard_expired'
            ? 'Organization trial ended without converting to a paid plan. KiloClaw is paused for everyone in this organization until an owner starts a paid subscription.'
            : 'Organization subscription ended. KiloClaw is paused for everyone in this organization until an owner reactivates it.',
      };
    }
    if (row.operationalKind === 'blocked_opt_out')
      // Yellow rather than red: opt-out is admin-controlled and reversible
      // from Organization Settings, not a billing failure.
      return {
        tone: 'yellow' as const,
        copy: 'KiloClaw is disabled for this organization. Re-enable it in organization settings to restore access.',
      };
    return null;
  })();

  return (
    <div className="space-y-6">
      <PageHeader
        backHref="/organizations/mock-org/subscriptions"
        backLabel="Back to subscriptions"
        title={row.instanceName ?? 'Unnamed instance'}
        statusBadge={<StatusBadge kind={row.operationalKind} />}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/organizations/mock-org/claw/settings">
              Open KiloClaw settings
              <ExternalLink className="!size-3.5" />
            </Link>
          </Button>
        }
      />
      {note && <NoteCallout tone={note.tone} copy={note.copy} />}

      <Card>
        <CardHeader>
          <CardTitle>Subscription details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <CardKV label="Plan">Organization</CardKV>
            <CardKV label="Price" mono>
              {formatMicrodollars(row.renewalCostMicrodollars)} / month from credits
            </CardKV>
            <CardKV label="Next renewal" mono>
              {formatDate(row.currentPeriodEnd)}
            </CardKV>
            {row.status === 'trialing' && row.trialKind && (
              <>
                <CardKV label="Trial ends" mono>
                  {formatDate(row.trialEndsAt)}
                </CardKV>
                <CardKV label="Trial type">{trialTypeCopy(row.trialKind)}</CardKV>
              </>
            )}
            {row.suspendedAt && (
              <CardKV label="Suspended at" mono>
                {formatDate(row.suspendedAt)}
              </CardKV>
            )}
          </div>
          <div className="border-t pt-5">
            <CardKV label="Associated user">
              <div className="flex flex-wrap items-center gap-2">
                <User className="text-muted-foreground h-4 w-4" aria-hidden="true" />
                <span>{row.associatedUserDisplayName}</span>
                <span className="text-muted-foreground">({row.associatedUserEmail})</span>
              </div>
            </CardKV>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Billing history</CardTitle>
          <CardDescription>Credit deductions for this instance.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/20 text-muted-foreground">
                <tr>
                  <th className="h-12 px-4 text-left font-semibold">Date</th>
                  <th className="h-12 px-4 text-left font-semibold">Description</th>
                  <th className="h-12 px-4 text-left font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {history.map(entry => (
                  <tr key={entry.id} className="border-t">
                    <td className="px-4 py-3 font-mono">{formatDate(entry.date)}</td>
                    <td className="px-4 py-3">{entry.description}</td>
                    <td className="px-4 py-3 font-mono">
                      {entry.amountMicrodollars === 0
                        ? 'No charge'
                        : formatMicrodollars(entry.amountMicrodollars)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button variant="outline" className="mt-3">
            Show more
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wave A — OrgKiloClawGroup (subscriptions page section)
// ---------------------------------------------------------------------------

export function OrgKiloClawGroupPreview({
  rows,
  showTerminal,
}: {
  rows: KiloClawOrgSubscriptionRow[];
  showTerminal: boolean;
}) {
  const visible = rows.filter(r => showTerminal || r.status !== 'canceled');

  return (
    <section className="rounded-xl border bg-card/30 p-6 shadow-sm">
      <div className="space-y-5">
        <div className="flex items-center gap-4">
          <div className="bg-muted flex h-12 w-12 items-center justify-center rounded-2xl border">
            <KiloCrabIcon className="text-foreground h-5 w-5" />
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">KiloClaw</h2>
            <p className="text-muted-foreground text-sm">
              Hosting subscriptions for organization KiloClaw instances.
            </p>
          </div>
        </div>
        <div className="border-t" />
        {visible.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-start gap-3 p-6">
              <p className="text-sm">
                No KiloClaw subscriptions yet. Members can provision an organization KiloClaw
                instance.
              </p>
              <Button variant="outline" asChild>
                <Link href="/organizations/mock-org/claw/new">Provision KiloClaw</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead className="px-4">Instance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead>Renews on</TableHead>
                  <TableHead className="w-8 px-4" aria-label="Open" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map(row => (
                  <OrgKiloClawSubscriptionRow key={row.instanceId} row={row} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </section>
  );
}

function OrgKiloClawSubscriptionRow({ row }: { row: KiloClawOrgSubscriptionRow }) {
  // The whole row links to the subscription detail page via a stretched link
  // anchored on the instance name. `cancelAtPeriodEnd` is only surfaced as a
  // separate badge when the operational kind doesn't already say "Canceling",
  // so we don't double up on dan-experiments-style rows.
  const showCancelingBadge =
    row.cancelAtPeriodEnd && row.operationalKind !== 'canceling_at_period_end';
  const showCanceledBadge = row.status === 'canceled';

  return (
    <TableRow
      className={cn('group relative cursor-pointer', row.status === 'canceled' && 'opacity-60')}
    >
      <TableCell className="px-4 py-3">
        <Link
          href={`/organizations/mock-org/subscriptions/kiloclaw/${row.instanceId}`}
          className="font-medium before:absolute before:inset-0 group-hover:underline"
        >
          {row.instanceName ?? 'Unnamed'}
        </Link>
      </TableCell>
      <TableCell className="py-3">
        <div className="flex flex-wrap gap-1.5">
          <StatusBadge kind={row.operationalKind} />
          {showCancelingBadge && <StatusBadge kind="canceling_at_period_end" />}
          {showCanceledBadge && <StatusBadge kind="canceled" />}
        </div>
      </TableCell>
      <TableCell className="py-3">
        <div className="flex flex-col leading-tight">
          <span className="text-foreground text-sm">{row.associatedUserDisplayName}</span>
          <span className="text-muted-foreground text-xs">{row.associatedUserEmail}</span>
        </div>
      </TableCell>
      <TableCell className="py-3 text-right font-mono text-sm tabular-nums">
        {formatMicrodollars(row.renewalCostMicrodollars)} / mo
      </TableCell>
      <TableCell className="py-3 font-mono text-sm tabular-nums">
        {formatDate(row.currentPeriodEnd)}
      </TableCell>
      <TableCell className="w-8 px-4 py-3 text-right">
        <ChevronRight className="text-muted-foreground h-4 w-4" />
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Wave A — OrgKiloClawAlertTile (org dashboard)
// ---------------------------------------------------------------------------

export function OrgKiloClawAlertTilePreview({ summary }: { summary: OrgKiloclawHealthSummary }) {
  const total =
    summary.pastDueCount + summary.suspendedCount + summary.canceledByParentEntitlementCount;
  if (total === 0) return null;

  return (
    <Card className="border-yellow-500/30 bg-yellow-500/10">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TriangleAlert className="text-yellow-400 h-5 w-5" />
          KiloClaw subscriptions need attention
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="text-muted-foreground space-y-1.5 text-sm">
          {summary.pastDueCount > 0 && (
            <li>
              <span className="text-foreground font-medium">{summary.pastDueCount}</span> past due
            </li>
          )}
          {summary.suspendedCount > 0 && (
            <li>
              <span className="text-foreground font-medium">{summary.suspendedCount}</span>{' '}
              suspended after grace period
            </li>
          )}
          {summary.canceledByParentEntitlementCount > 0 && (
            <li>
              <span className="text-foreground font-medium">
                {summary.canceledByParentEntitlementCount}
              </span>{' '}
              canceled (organization subscription ended)
            </li>
          )}
        </ul>
        <Button variant="outline" asChild>
          <Link href="/organizations/mock-org/subscriptions">Triage subscriptions</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Wave B — OrgKiloClawAssociatedUserBanner (org dashboard, self-focused)
// ---------------------------------------------------------------------------

type OrgAssociatedUserBannerVariant =
  | 'past-due-admin'
  | 'past-due-member'
  | 'blocked-parent-entitlement'
  | 'blocked-opt-out'
  | 'canceling-at-period-end'
  | 'launch-trial-ending-soon'
  | 'user-trial-ending-soon';

export function deriveOrgAssociatedUserBannerVariant(
  operational: OrgBillingOperationalState,
  role: 'admin' | 'member'
): OrgAssociatedUserBannerVariant | null {
  switch (operational.kind) {
    case 'past_due':
      return role === 'admin' ? 'past-due-admin' : 'past-due-member';
    case 'blocked_parent_entitlement':
      return 'blocked-parent-entitlement';
    case 'blocked_opt_out':
      return 'blocked-opt-out';
    case 'canceling_at_period_end':
      return 'canceling-at-period-end';
    case 'trialing':
      if (operational.trialKind === '30day_launch' && operational.daysRemaining <= 7)
        return 'launch-trial-ending-soon';
      if (operational.trialKind === '7day_user' && operational.daysRemaining <= 2)
        return 'user-trial-ending-soon';
      return null;
    case 'available':
    default:
      return null;
  }
}

export function OrgKiloClawAssociatedUserBannerPreview({ status }: { status: OrgBillingStatus }) {
  const variant = deriveOrgAssociatedUserBannerVariant(status.operational, status.role);
  if (!variant) {
    return (
      <div className="text-muted-foreground rounded-xl border border-dashed p-4 text-sm">
        Banner self-suppressed (variant === null).
      </div>
    );
  }

  switch (variant) {
    case 'past-due-admin':
      return (
        <Banner color="red">
          <Banner.Icon>
            <CreditCard />
          </Banner.Icon>
          <Banner.Content>
            <Banner.Title>Your KiloClaw renewal failed</Banner.Title>
            <Banner.Description>
              Top up organization credits to keep your instance running.
            </Banner.Description>
          </Banner.Content>
          <SubtleBannerButton href="/organizations/mock-org/payment-details">
            Top up credits
          </SubtleBannerButton>
        </Banner>
      );
    case 'past-due-member':
      return (
        <Banner color="red">
          <Banner.Icon>
            <AlertTriangle />
          </Banner.Icon>
          <Banner.Content>
            <Banner.Title>Your KiloClaw is past due</Banner.Title>
            <Banner.Description>
              Ask a billing administrator to top up organization credits.
            </Banner.Description>
          </Banner.Content>
        </Banner>
      );
    case 'blocked-parent-entitlement':
      return (
        <Banner color="red">
          <Banner.Icon>
            <Ban />
          </Banner.Icon>
          <Banner.Content>
            <Banner.Title>Your KiloClaw is paused</Banner.Title>
            <Banner.Description>
              The organization subscription is inactive. KiloClaw cannot be used until it is
              reactivated.
            </Banner.Description>
          </Banner.Content>
          {status.role === 'admin' && (
            <SubtleBannerButton href="/organizations/mock-org/subscription">
              Manage organization subscription
            </SubtleBannerButton>
          )}
        </Banner>
      );
    case 'blocked-opt-out':
      return (
        <Banner color="red">
          <Banner.Icon>
            <ShieldOff />
          </Banner.Icon>
          <Banner.Content>
            <Banner.Title>Your KiloClaw is disabled</Banner.Title>
            <Banner.Description>
              {status.role === 'admin'
                ? 'KiloClaw is disabled for this organization. Re-enable in settings.'
                : 'Your administrator has disabled KiloClaw for this organization.'}
            </Banner.Description>
          </Banner.Content>
          {status.role === 'admin' && (
            <SubtleBannerButton href="/organizations/mock-org/settings?tab=kiloclaw">
              Manage in settings
            </SubtleBannerButton>
          )}
        </Banner>
      );
    case 'canceling-at-period-end':
      return (
        <Banner color="yellow">
          <Banner.Icon>
            <AlertCircle />
          </Banner.Icon>
          <Banner.Content>
            <Banner.Title>Your KiloClaw subscription is ending</Banner.Title>
            <Banner.Description>
              {status.operational.kind === 'canceling_at_period_end'
                ? `Subscription ends on ${formatDate(status.operational.endsAt)}.`
                : ''}
            </Banner.Description>
          </Banner.Content>
          <SubtleBannerButton href="/organizations/mock-org/claw/subscription">
            View instance
          </SubtleBannerButton>
        </Banner>
      );
    case 'launch-trial-ending-soon':
      return (
        <Banner color="yellow">
          <Banner.Icon>
            <Clock />
          </Banner.Icon>
          <Banner.Content>
            <Banner.Title>30-day launch trial ending soon</Banner.Title>
            <Banner.Description>
              {status.operational.kind === 'trialing'
                ? `${pluralizeDays(status.operational.daysRemaining)} remaining. Renews from organization credits.`
                : ''}
            </Banner.Description>
          </Banner.Content>
          <SubtleBannerButton href="/organizations/mock-org/claw/subscription">
            Manage subscription
          </SubtleBannerButton>
        </Banner>
      );
    case 'user-trial-ending-soon':
      return (
        <Banner color="yellow">
          <Banner.Icon>
            <Clock />
          </Banner.Icon>
          <Banner.Content>
            <Banner.Title>7-day trial ending soon</Banner.Title>
            <Banner.Description>
              {status.operational.kind === 'trialing'
                ? `${pluralizeDays(status.operational.daysRemaining)} remaining. Renews from organization credits.`
                : ''}
            </Banner.Description>
          </Banner.Content>
          <SubtleBannerButton href="/organizations/mock-org/claw/subscription">
            Manage subscription
          </SubtleBannerButton>
        </Banner>
      );
  }
}

// ---------------------------------------------------------------------------
// Wave C — AssociatedUserChip
// ---------------------------------------------------------------------------

export function AssociatedUserChip({
  associatedUser,
  currentUserId,
  className,
}: {
  associatedUser: AssociatedUser | null;
  currentUserId: string;
  className?: string;
}) {
  if (!associatedUser) return null;
  const isSelf = associatedUser.id === currentUserId;
  return (
    <p className={cn('text-muted-foreground flex items-center gap-1.5 text-xs', className)}>
      <User className="h-3 w-3" />
      <span>
        Associated with{' '}
        <span className="text-foreground font-medium">{associatedUser.displayName}</span>{' '}
        <span className="text-muted-foreground">({associatedUser.email})</span>
        {isSelf && <span className="text-muted-foreground ml-1">(you)</span>}
      </span>
    </p>
  );
}

/**
 * Mock InstanceControls header to show where the chip lands.
 */
export function InstanceControlsHeaderPreview({
  associatedUser,
  currentUserId,
}: {
  associatedUser: AssociatedUser | null;
  currentUserId: string;
}) {
  // Two clusters separated by a divider:
  //   1. Instance identity: name + edit + owner chip + hardware spec badges.
  //      Specs describe the instance, so they belong with the name, not with
  //      the controls heading they previously sat next to.
  //   2. Instance controls section heading.
  return (
    <Card>
      <CardContent className="p-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">alice-dev</h2>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground rounded-md p-1"
              aria-label="Edit name"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
            </button>
          </div>
          <AssociatedUserChip associatedUser={associatedUser} currentUserId={currentUserId} />
          <div className="flex flex-wrap gap-2 pt-1">
            <Badge variant="outline" className="text-muted-foreground gap-1.5 font-normal">
              <span className="font-mono">2 vCPU, 4 GB RAM</span>
            </Badge>
            <Badge variant="outline" className="text-muted-foreground gap-1.5 font-normal">
              <span className="font-mono">10 GB SSD</span>
            </Badge>
          </div>
        </div>
        <div className="mt-5 border-t pt-5">
          <h3 className="text-foreground text-sm font-medium">Instance Controls</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            Manage power state and gateway lifecycle.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Org dashboard tile composition (banner + alert tile, mounted on dashboard)
// ---------------------------------------------------------------------------

export function OrgDashboardWithBannerAndTile({
  status,
  summary,
}: {
  status: OrgBillingStatus;
  summary: OrgKiloclawHealthSummary;
}) {
  return (
    <div className="space-y-4 rounded-xl border bg-background/50 p-4">
      <p className="text-muted-foreground text-xs uppercase tracking-wide">
        Org dashboard · banner above tile (Wave B + Wave A)
      </p>
      <div className="space-y-4">
        <OrgKiloClawAssociatedUserBannerPreview status={status} />
        <OrgKiloClawAlertTilePreview summary={summary} />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <Users className="mr-2 inline h-4 w-4" />
              Members
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              (Existing members card rendered here, unchanged.)
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kilo Admin — internal support and ops previews
// ---------------------------------------------------------------------------

function StatPillLike({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="flex flex-1 flex-col gap-0.5">
      <span className="text-muted-foreground text-[11px] font-semibold tracking-[0.06em] uppercase">
        {label}
      </span>
      <span className="text-2xl font-bold tabular-nums">{value}</span>
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </div>
  );
}

function AdminMetric({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'neutral' | 'warning' | 'danger' | 'success';
}) {
  const styles: Record<typeof tone, string> = {
    neutral: 'border-border bg-card/40',
    warning: 'border-yellow-500/20 bg-yellow-500/5',
    danger: 'border-red-500/20 bg-red-500/5',
    success: 'border-emerald-500/20 bg-emerald-500/5',
  };

  return (
    <div className={cn('rounded-xl border p-4', styles[tone])}>
      <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
        {label}
      </p>
      <p className="text-foreground mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-muted-foreground mt-1 text-xs">{hint}</p>}
    </div>
  );
}

function ScopeBadge({ scope }: { scope: KiloAdminKiloclawInstanceRow['scope'] }) {
  return (
    <Badge variant="outline" className="gap-1.5 rounded-full text-[11px] capitalize">
      {scope === 'organization' ? <Users className="h-3 w-3" /> : <User className="h-3 w-3" />}
      {scope}
    </Badge>
  );
}

function TrialBadge({
  trialKind,
  isLaunchBackfill,
}: {
  trialKind: '7day_user' | '30day_launch' | null;
  isLaunchBackfill: boolean;
}) {
  if (!trialKind) return null;
  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-full border-transparent px-2.5 py-1 text-[11px] ring-1',
        isLaunchBackfill
          ? 'bg-blue-500/10 text-blue-400 ring-blue-500/20'
          : 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
      )}
    >
      {trialKind === '30day_launch' ? '30-day launch' : '7-day trial'}
    </Badge>
  );
}

function OperationalBadge({ kind }: { kind: OrgBillingOperationalState['kind'] }) {
  return <StatusBadge kind={kind} />;
}

function ParentEntitlementBadge({
  state,
}: {
  state: KiloAdminKiloclawInstanceRow['parentEntitlement'];
}) {
  if (!state) return <span className="text-muted-foreground">None</span>;
  const className =
    state === 'active'
      ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
      : state === 'trialing'
        ? 'bg-blue-500/10 text-blue-400 ring-blue-500/20'
        : 'bg-red-500/10 text-red-400 ring-red-500/20';
  return (
    <Badge variant="outline" className={cn('rounded-full border-transparent ring-1', className)}>
      {state.replace('_', ' ')}
    </Badge>
  );
}

function AdminRuntimeBadge({ suspended }: { suspended: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-full border-transparent text-[11px] ring-1',
        suspended
          ? 'bg-yellow-500/10 text-yellow-400 ring-yellow-500/20'
          : 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
      )}
    >
      {suspended ? 'Suspended' : 'Active'}
    </Badge>
  );
}

function ReadonlyFilterPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-input bg-background flex h-9 min-w-0 items-center gap-2 rounded-md border px-3 text-sm">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-foreground truncate font-medium">{value}</span>
    </div>
  );
}

export function KiloAdminKiloclawListPreview({
  rows,
  stats,
}: {
  rows: KiloAdminKiloclawInstanceRow[];
  stats: KiloAdminKiloclawStats;
}) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card>
          <CardContent className="flex flex-wrap gap-x-8 gap-y-4 py-4">
            <StatPillLike
              label="Total"
              value={stats.totalInstances.toLocaleString()}
              hint="existing overview card"
            />
            <StatPillLike label="Organization" value={stats.organizationCount} />
            <StatPillLike label="Personal" value={stats.personalCount} />
            <StatPillLike
              label="Needs attention"
              value={stats.pastDueCount + stats.suspendedCount + stats.blockedParentCount}
              hint={`${stats.pastDueCount} past due · ${stats.suspendedCount} suspended`}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-medium">Daily instances</CardTitle>
            <CardDescription className="text-xs">
              Existing created/destroyed chart remains above the table.
            </CardDescription>
          </CardHeader>
          <CardContent className="pb-3">
            <div className="border-border bg-muted/20 flex h-[96px] items-end gap-2 rounded-lg border px-4 py-3">
              {[28, 52, 36, 68, 44, 82, 56, 72, 38, 64, 48, 78].map((height, index) => (
                <div key={index} className="flex flex-1 items-end gap-1">
                  <span className="block w-full rounded-sm bg-emerald-500/70" style={{ height }} />
                  <span
                    className="block w-full rounded-sm bg-red-500/60"
                    style={{ height: Math.max(12, height - 24) }}
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle>All KiloClaw instances</CardTitle>
              <CardDescription>
                Existing admin list with org-billing columns added; search, filters, selection,
                version controls, sorting, and pagination stay intact.
              </CardDescription>
            </div>
            <Button variant="destructive" size="sm">
              Nuke all (dev)
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="border-input bg-background flex h-9 min-w-[320px] flex-1 items-center gap-2 rounded-md border px-3 text-sm">
              <Search className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
              <span className="text-muted-foreground truncate">
                Search by user ID, sandbox ID, or instance ID…
              </span>
            </div>
            <Button variant="secondary" size="sm">
              Search
            </Button>
            <ReadonlyFilterPill label="Status" value="All instances" />
            <ReadonlyFilterPill label="Version" value="All versions" />
            <Button variant="outline" size="sm">
              Has size override
            </Button>
          </div>

          <div className="text-muted-foreground border-border/60 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
            <AlertCircle className="h-3 w-3 opacity-60" />
            <span>Use the checkboxes to select rows for bulk version changes.</span>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40px] px-4">
                    <input type="checkbox" aria-label="Select all visible instances" />
                  </TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Org</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Pin</TableHead>
                  <TableHead>Subscription</TableHead>
                  <TableHead>Org billing</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Sandbox ID</TableHead>
                  <TableHead>Destroyed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow key={row.instanceId} className="hover:bg-muted/50 group cursor-pointer">
                    <TableCell className="px-4 py-3">
                      <input type="checkbox" aria-label={`Select instance ${row.sandboxId}`} />
                    </TableCell>
                    <TableCell className="py-3">
                      <Link
                        href={`/admin/users/${row.associatedUserId}`}
                        className="relative z-10 hover:underline"
                      >
                        {row.associatedUserEmail}
                      </Link>
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ScopeBadge scope={row.scope} />
                        {row.organizationId && (
                          <Link
                            href={`/admin/organizations/${row.organizationId}`}
                            className="relative z-10 text-xs hover:underline"
                          >
                            {row.organizationName}
                          </Link>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-3 text-xs">
                      <div className="flex flex-col">
                        <span className="font-medium">
                          v2026.05.{String(index + 8).padStart(2, '0')}
                        </span>
                        <span className="text-muted-foreground font-mono">
                          openclaw-{index + 31}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="py-3">
                      {index % 3 === 0 ? (
                        <Badge
                          variant="outline"
                          className="border-transparent bg-purple-500/20 text-purple-400 ring-1 ring-purple-500/20"
                        >
                          Admin pin
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">None</span>
                      )}
                    </TableCell>
                    <TableCell className="py-3">
                      {row.subscriptionStatus ? (
                        <Badge variant="outline" className="rounded-full text-[11px]">
                          {row.subscriptionStatus.replace('_', ' ')}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">Missing</span>
                      )}
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="flex flex-wrap gap-1.5">
                        <OperationalBadge kind={row.operationalKind} />
                        <TrialBadge
                          trialKind={row.trialKind}
                          isLaunchBackfill={row.isLaunchBackfill}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="py-3">
                      <AdminRuntimeBadge suspended={Boolean(row.suspendedAt)} />
                    </TableCell>
                    <TableCell className="text-muted-foreground py-3 text-sm">2d ago</TableCell>
                    <TableCell className="text-muted-foreground max-w-[130px] truncate py-3 font-mono text-xs">
                      {row.sandboxId}
                    </TableCell>
                    <TableCell className="text-muted-foreground py-3 text-sm">
                      {row.subscriptionStatus === 'canceled' ? '12d ago' : 'Not destroyed'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-muted-foreground text-sm">
              Showing 1 to {rows.length} of 742 instances
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm">
                <ChevronLeft className="h-4 w-4" /> Previous
              </Button>
              <span className="text-sm">Page 1 of 38</span>
              <Button variant="outline" size="sm">
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function KiloAdminInstanceBillingSupportPreview({
  row,
  changeLogs,
}: {
  row: KiloAdminKiloclawInstanceRow;
  changeLogs: KiloAdminChangeLogEntry[];
}) {
  const callout = (() => {
    if (row.operationalKind === 'past_due' && row.suspendedAt) {
      return {
        tone: 'red' as const,
        copy: 'Renewal failed and the grace period elapsed. Support should confirm org credits or auto top-up before resuming.',
      };
    }
    if (row.operationalKind === 'blocked_parent_entitlement') {
      return {
        tone: 'red' as const,
        copy:
          row.blockingReason === 'org_subscription_ended'
            ? 'Parent organization entitlement ended. Org KiloClaw access is blocked independently of this local subscription status.'
            : 'Organization trial hard-expired. Access is blocked, but the KiloClaw subscription is not immediately canceled by that state alone.',
      };
    }
    if (row.operationalKind === 'blocked_opt_out') {
      return {
        tone: 'yellow' as const,
        copy: 'Enterprise KiloClaw opt-out is enforced. Provisioning, access, and renewal are blocked while the setting remains enabled.',
      };
    }
    if (row.operationalKind === 'canceling_at_period_end') {
      return {
        tone: 'yellow' as const,
        copy: `Instance was destroyed. Subscription remains visible until it cancels on ${formatDate(row.currentPeriodEnd)} with no refund or proration.`,
      };
    }
    return null;
  })();

  return (
    <div className="space-y-6">
      <PageHeader
        backHref="/admin/kiloclaw"
        backLabel="Back to admin KiloClaw"
        title={row.instanceName ?? row.instanceId}
        statusBadge={<OperationalBadge kind={row.operationalKind} />}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/users/${row.associatedUserId}`}>
                User admin
                <ExternalLink className="!size-3.5" />
              </Link>
            </Button>
            {row.organizationId && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/admin/organizations/${row.organizationId}`}>
                  Org admin
                  <ExternalLink className="!size-3.5" />
                </Link>
              </Button>
            )}
          </div>
        }
      />

      {callout && <NoteCallout tone={callout.tone} copy={callout.copy} />}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Instance information</CardTitle>
              <CardDescription>
                Existing detail-page controls and runtime identity remain; org billing adds context
                below instead of replacing this card.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <AdminRuntimeBadge suspended={Boolean(row.suspendedAt)} />
              <Button variant="destructive" size="sm">
                <Trash2 className="mr-1 size-4" /> Destroy instance
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <CardKV label="User">
            <Link href={`/admin/users/${row.associatedUserId}`} className="hover:underline">
              {row.associatedUserEmail}
            </Link>
          </CardKV>
          <CardKV label="Sandbox ID" mono>
            {row.sandboxId}
          </CardKV>
          <CardKV label="Created">2 days ago</CardKV>
          <CardKV label="Destroyed">Not destroyed</CardKV>
          <CardKV label="Type">
            <ScopeBadge scope={row.scope} />
          </CardKV>
          <CardKV label="Instance ID" mono>
            {row.instanceId}
          </CardKV>
          {row.organizationId && (
            <CardKV label="Organization ID" mono>
              {row.organizationId}
            </CardKV>
          )}
          <CardKV label="Fly app" mono>
            {row.sandboxId}
          </CardKV>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader>
            <CardTitle>Billing support</CardTitle>
            <CardDescription>
              Normalized internal payload for support triage. Org rows are credit-funded by the
              organization, not the associated user.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <CardKV label="Scope">
                <ScopeBadge scope={row.scope} />
              </CardKV>
              <CardKV label="Subscription status">
                {row.subscriptionStatus?.replace('_', ' ') ?? 'missing'}
              </CardKV>
              <CardKV label="Payment source">
                {row.paymentSource === 'credits'
                  ? row.providerSubscriptionId
                    ? 'Hybrid credits'
                    : 'Pure organization credits'
                  : 'Stripe'}
              </CardKV>
              <CardKV label="Current period" mono>
                {formatDate(row.currentPeriodStart)} → {formatDate(row.currentPeriodEnd)}
              </CardKV>
              <CardKV label="Credit renewal" mono>
                {formatDate(row.creditRenewalAt)}
              </CardKV>
              <CardKV label="Renewal cost" mono>
                {row.renewalCostMicrodollars == null
                  ? 'Not set'
                  : formatMicrodollars(row.renewalCostMicrodollars)}
              </CardKV>
              <CardKV label="Trial">
                <TrialBadge trialKind={row.trialKind} isLaunchBackfill={row.isLaunchBackfill} />
                {!row.trialKind && <span className="text-muted-foreground">No trial</span>}
              </CardKV>
              <CardKV label="Parent entitlement">
                <ParentEntitlementBadge state={row.parentEntitlement} />
              </CardKV>
              <CardKV label="Enterprise opt-out">
                {row.optOutEnforced
                  ? 'Enforced'
                  : row.optOutSetting
                    ? 'Stored, not enforced'
                    : 'Off'}
              </CardKV>
            </div>

            <div className="grid gap-4 rounded-xl border p-4 sm:grid-cols-2">
              <CardKV label="Associated user">
                <Link href={`/admin/users/${row.associatedUserId}`} className="hover:underline">
                  {row.associatedUserDisplayName}
                </Link>
                <p className="text-muted-foreground text-xs">{row.associatedUserEmail}</p>
              </CardKV>
              <CardKV label="Organization">
                {row.organizationId ? (
                  <>
                    <Link
                      href={`/admin/organizations/${row.organizationId}`}
                      className="hover:underline"
                    >
                      {row.organizationName}
                    </Link>
                    <p className="text-muted-foreground text-xs capitalize">
                      {row.organizationPlan} · balance{' '}
                      {formatMicrodollars(row.orgCreditBalanceMicrodollars ?? 0)} · auto top-up{' '}
                      {row.orgAutoTopUpEnabled ? 'on' : 'off'}
                    </p>
                  </>
                ) : (
                  <span className="text-muted-foreground">Personal context</span>
                )}
              </CardKV>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link
                  href={`/organizations/${row.organizationId ?? 'personal'}/subscriptions/kiloclaw/${row.instanceId}`}
                >
                  Customer subscription page
                  <ExternalLink className="!size-3.5" />
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href="#admin-change-log">
                  Subscription change log
                  <ChevronRight />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Raw IDs</CardTitle>
            <CardDescription>Copy/paste handles for logs and worker traces.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <CardKV label="Instance ID" mono>
              {row.instanceId}
            </CardKV>
            <CardKV label="Sandbox ID" mono>
              {row.sandboxId}
            </CardKV>
            <CardKV label="Subscription ID" mono>
              {row.subscriptionId ?? 'None'}
            </CardKV>
            <CardKV label="Provider subscription" mono>
              {row.providerSubscriptionId ?? 'None'}
            </CardKV>
          </CardContent>
        </Card>
      </div>

      <KiloAdminChangeLogPreview entries={changeLogs} />
    </div>
  );
}

export function KiloAdminMutationSafetyPreview() {
  const rows = [
    {
      action: 'Update trial end',
      personal: 'Keep existing personal-trial admin flow.',
      organization: 'Not available for org rows.',
      state: 'disabled' as const,
    },
    {
      action: 'Cancel subscription',
      personal: 'Keep existing personal cancellation flow.',
      organization: 'Customer-facing org termination is Destroy only in MVP.',
      state: 'disabled' as const,
    },
    {
      action: 'Destroy instance',
      personal: 'Keep existing destroy behavior.',
      organization: 'Allowed as an explicit override with audit + subscription changelog writes.',
      state: 'danger' as const,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin mutation guardrails</CardTitle>
        <CardDescription>
          Existing personal controls remain. Org rows only add clear disabled states or explicit
          audited overrides.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 lg:grid-cols-3">
          {rows.map(row => (
            <div key={row.action} className="rounded-xl border p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium">{row.action}</p>
                {row.state === 'danger' ? (
                  <Badge variant="destructive" className="rounded-full">
                    Override
                  </Badge>
                ) : (
                  <Badge variant="outline" className="rounded-full">
                    Disabled for org
                  </Badge>
                )}
              </div>
              <div className="mt-3 space-y-2 text-sm">
                <p>
                  <span className="text-muted-foreground">Personal: </span>
                  {row.personal}
                </p>
                <p>
                  <span className="text-muted-foreground">Organization: </span>
                  {row.organization}
                </p>
              </div>
              <div className="mt-4">
                {row.state === 'danger' ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="bg-red-500 text-white hover:bg-red-500/90"
                  >
                    Admin override
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" disabled>
                    Disabled
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
        <NoteCallout
          tone="yellow"
          copy="Org destroy must call out immediate infrastructure teardown, period-end cancellation, no refund/proration, KiloClaw admin audit log, and subscription change-log entry."
        />
      </CardContent>
    </Card>
  );
}

export function KiloAdminOrganizationKiloclawPreview({
  summary,
}: {
  summary: KiloAdminOrgSupportSummary;
}) {
  const { organization, health, rows } = summary;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>KiloClaw support</CardTitle>
            <CardDescription>
              Organization-level support card for `/admin/organizations/[id]`.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="rounded-full capitalize">
              {organization.plan}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                'rounded-full border-transparent ring-1',
                organization.kiloclawOptOut
                  ? 'bg-red-500/10 text-red-400 ring-red-500/20'
                  : 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
              )}
            >
              Opt-out {organization.kiloclawOptOut ? 'on' : 'off'}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <AdminMetric label="Active instances" value={health.activeInstanceCount} />
          <AdminMetric
            label="Credit balance"
            value={formatMicrodollars(organization.creditBalanceMicrodollars)}
            hint={`auto top-up ${organization.autoTopUpEnabled ? 'on' : 'off'}`}
            tone="success"
          />
          <AdminMetric
            label="Next-period cost"
            value={formatMicrodollars(health.totalRenewalCostMicrodollars)}
            hint="all active org KC rows"
          />
          <AdminMetric
            label="Needs attention"
            value={health.pastDueCount + health.suspendedCount + health.blockedParentCount}
            hint={`${health.pastDueCount} past due · ${health.suspendedCount} suspended`}
            tone="warning"
          />
          <AdminMetric label="Paid active" value={health.activePaidCount} />
          <AdminMetric label="7-day trials" value={health.sevenDayTrialingCount} />
          <AdminMetric label="Launch trials" value={health.launchTrialingCount} />
          <AdminMetric label="Canceling" value={health.cancelingAtPeriodEndCount} />
        </div>

        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="px-4">Instance</TableHead>
                <TableHead>Associated user</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Trial</TableHead>
                <TableHead>Renews</TableHead>
                <TableHead className="w-8 px-4" aria-label="Open" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(row => (
                <TableRow key={row.instanceId} className="group relative cursor-pointer">
                  <TableCell className="px-4 py-3">
                    <Link
                      href={`/admin/kiloclaw/${row.instanceId}`}
                      className="font-medium before:absolute before:inset-0 group-hover:underline"
                    >
                      {row.instanceName ?? 'Unnamed instance'}
                    </Link>
                    <p className="text-muted-foreground font-mono text-xs">{row.instanceId}</p>
                  </TableCell>
                  <TableCell className="py-3">
                    <div className="leading-tight">
                      <p className="text-sm">{row.associatedUserDisplayName}</p>
                      <p className="text-muted-foreground text-xs">{row.associatedUserEmail}</p>
                    </div>
                  </TableCell>
                  <TableCell className="py-3">
                    <StatusBadge
                      kind={row.status === 'canceled' ? 'canceled' : row.operationalKind}
                    />
                  </TableCell>
                  <TableCell className="py-3">
                    <TrialBadge trialKind={row.trialKind} isLaunchBackfill={row.isLaunchBackfill} />
                    {!row.trialKind && (
                      <span className="text-muted-foreground text-sm">No trial</span>
                    )}
                  </TableCell>
                  <TableCell className="py-3 font-mono text-sm tabular-nums">
                    {formatDate(row.currentPeriodEnd)}
                  </TableCell>
                  <TableCell className="w-8 px-4 py-3 text-right">
                    <ChevronRight className="text-muted-foreground h-4 w-4" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export function KiloAdminUserKiloclawPreview({
  summary,
}: {
  summary: KiloAdminUserSupportSummary;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>User KiloClaw tab · org-aware</CardTitle>
        <CardDescription>
          Personal access and organization-funded KiloClaw rows are separated so support does not
          apply personal actions to org subscriptions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="rounded-xl border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Personal KiloClaw</p>
              <p className="text-muted-foreground text-xs">
                {summary.personal.activeInstanceId
                  ? `${summary.personal.instanceName} · ${summary.personal.subscriptionStatus}`
                  : 'No active personal KiloClaw instance'}
              </p>
            </div>
            <Button variant="outline" size="sm" disabled={!summary.personal.actionsEnabled}>
              Personal actions
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <p className="text-sm font-semibold">Organization KiloClaw</p>
            <p className="text-muted-foreground text-xs">
              Org rows remain visible but personal trial/cancel controls are replaced with
              org-specific support context.
            </p>
          </div>
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead className="px-4">Organization</TableHead>
                  <TableHead>Instance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Funding</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.organizationRows.map(row => (
                  <TableRow key={row.instanceId}>
                    <TableCell className="px-4 py-3">
                      <Link
                        href={`/admin/organizations/${row.organizationId}`}
                        className="font-medium hover:underline"
                      >
                        {row.organizationName}
                      </Link>
                      <p className="text-muted-foreground text-xs capitalize">
                        {row.organizationPlan}
                      </p>
                    </TableCell>
                    <TableCell className="py-3">
                      <Link href={`/admin/kiloclaw/${row.instanceId}`} className="hover:underline">
                        {row.instanceName ?? row.instanceId}
                      </Link>
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="flex flex-wrap gap-1.5">
                        <StatusBadge kind={row.operationalKind} />
                        <TrialBadge
                          trialKind={row.trialKind}
                          isLaunchBackfill={row.isLaunchBackfill}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="py-3 text-sm">{row.orgFundedLabel}</TableCell>
                    <TableCell className="py-3">
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" size="sm" asChild>
                            <Link href={`/admin/kiloclaw/${row.instanceId}`}>Open instance</Link>
                          </Button>
                          <Button variant="outline" size="sm" disabled>
                            Personal actions disabled
                          </Button>
                        </div>
                        <p className="text-muted-foreground max-w-sm text-xs">
                          {row.personalActionsDisabledReason}
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function KiloAdminChangeLogPreview({ entries }: { entries: KiloAdminChangeLogEntry[] }) {
  const [selectedEntry, setSelectedEntry] = useState<KiloAdminChangeLogEntry | null>(null);

  return (
    <>
      <Card id="admin-change-log">
        <CardHeader>
          <CardTitle>Subscription change log</CardTitle>
          <CardDescription>
            Instance and organization pages link here so support can inspect canonical billing
            mutations without reconstructing state from app logs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead className="px-4">Time</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="w-12 text-right">Diff</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map(entry => (
                  <TableRow key={entry.id}>
                    <TableCell className="px-4 py-3 font-mono text-xs tabular-nums">
                      {formatDate(entry.timestamp)}
                    </TableCell>
                    <TableCell className="py-3 font-mono text-xs">{entry.actor}</TableCell>
                    <TableCell className="py-3">
                      <Badge variant="outline" className="rounded-full text-[11px]">
                        {entry.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-3 text-sm">{entry.reason}</TableCell>
                    <TableCell className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`View before and after for ${entry.action}`}
                        onClick={() => setSelectedEntry(entry)}
                      >
                        <FileText className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={selectedEntry !== null} onOpenChange={open => !open && setSelectedEntry(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Subscription change details</DialogTitle>
            <DialogDescription>
              Before and after payload for {selectedEntry?.action ?? 'this change'}.
            </DialogDescription>
          </DialogHeader>
          {selectedEntry && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Before</p>
                <p className="mt-2 font-mono text-sm break-words">{selectedEntry.before}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">After</p>
                <p className="mt-2 font-mono text-sm break-words">{selectedEntry.after}</p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

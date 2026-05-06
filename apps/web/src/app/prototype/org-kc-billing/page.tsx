/**
 * Prototype page for Organization KiloClaw billing UI.
 *
 * Renders every component proposed in `.plans/org-kiloclaw-billing-ui.md`
 * with mock data so the design can be reviewed before implementation.
 *
 * Route: /prototype/org-kc-billing
 *
 * Not gated by auth or org context — purely for design review. Delete this
 * directory once implementation begins, or keep as a living spec preview.
 */

'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  adminFixtures,
  associatedUserFixtures,
  billingHistoryFixture,
  detailRowFixtures,
  healthSummaryFixtures,
  memberFixtures,
  preflightFixtures,
  subscriptionRowsFixture,
  VIEWER_USER_ID,
} from './mock-data';
import {
  AssociatedUserChip,
  DashboardCTAsPreview,
  InstanceControlsHeaderPreview,
  OrgAccessLockedDialogPreview,
  OrgBillingBannerPreview,
  OrgDashboardWithBannerAndTile,
  OrgDestroyConfirmDialogPreview,
  OrgKiloClawAlertTilePreview,
  OrgKiloClawAssociatedUserBannerPreview,
  OrgKiloClawDetailPreview,
  OrgKiloClawGroupPreview,
  OrgProvisionPreflightError,
  OrgProvisionPreflightLoading,
  OrgProvisionPreflightPreview,
  OrgSubscriptionPagePreview,
  SidebarPreview,
} from './components';
import { OptOutTabClient } from './opt-out-client';

// ---------------------------------------------------------------------------
// Role filter
// ---------------------------------------------------------------------------

type Role = 'admin' | 'member';
type RoleVisibility = Role | 'both';

const RoleContext = createContext<Role>('admin');

function visibleForRole(roles: RoleVisibility, current: Role): boolean {
  return roles === 'both' || roles === current;
}

const ROLE_OPTIONS: { value: Role; label: string; description: string }[] = [
  {
    value: 'admin',
    label: 'Admin',
    description: 'Owner or billing manager',
  },
  {
    value: 'member',
    label: 'Member',
    description: 'Regular org member',
  },
];

// ---------------------------------------------------------------------------
// Section + Variant primitives (role-aware)
// ---------------------------------------------------------------------------

function Section({
  id,
  title,
  description,
  url,
  roles = 'both',
  children,
}: {
  id: string;
  title: string;
  description?: string;
  url: string;
  roles?: RoleVisibility;
  children: ReactNode;
}) {
  const role = useContext(RoleContext);
  if (!visibleForRole(roles, role)) return null;

  return (
    <section id={id} className="scroll-mt-24 space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
          {roles !== 'both' && (
            <span className="text-muted-foreground border-border rounded-md border px-2 py-0.5 text-[11px] uppercase tracking-wide">
              {roles} only
            </span>
          )}
        </div>
        <p className="text-muted-foreground font-mono text-xs">URL: {url}</p>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </header>
      <div className="space-y-12">{children}</div>
    </section>
  );
}

function Variant({
  label,
  caption,
  roles = 'both',
  children,
}: {
  label: string;
  caption?: string;
  roles?: RoleVisibility;
  children: ReactNode;
}) {
  const role = useContext(RoleContext);
  if (!visibleForRole(roles, role)) return null;

  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <p className="text-foreground text-sm font-semibold">{label}</p>
        {caption && <p className="text-muted-foreground text-xs">{caption}</p>}
      </div>
      <div className="bg-background/40 rounded-2xl border-2 border-dashed border-border p-4 md:p-6">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TOC — role-aware
// ---------------------------------------------------------------------------

// Ordered to follow an admin's journey through the product:
//   Org dashboard → Subscriptions → Settings → Provisioning → Inside a claw.
const TOC_ITEMS: { id: string; label: string; url: string; roles: RoleVisibility }[] = [
  // (0) Cross-PR navigation surfaces
  {
    id: 'navigation',
    label: 'Sidebar and dashboard navigation',
    url: '/organizations/[id]/* (sidebar) and /organizations/[id] (dashboard)',
    roles: 'both',
  },
  // (1–2) Org dashboard
  {
    id: 'wave-b',
    label: 'Personal KiloClaw alerts on dashboard',
    url: '/organizations/[id]',
    roles: 'both',
  },
  {
    id: 'wave-a-tile',
    label: 'Dashboard subscription alert',
    url: '/organizations/[id]',
    roles: 'admin',
  },
  // (3–4) Org Subscriptions page
  {
    id: 'wave-a-group',
    label: 'KiloClaw on the Subscriptions page',
    url: '/organizations/[id]/subscriptions',
    roles: 'admin',
  },
  {
    id: 'wave-a-detail',
    label: 'Subscription detail page',
    url: '/organizations/[id]/subscriptions/kiloclaw/[instanceId]',
    roles: 'admin',
  },
  // (5–6) Org Settings
  {
    id: 'pr4a',
    label: 'Organization Settings',
    url: '/organizations/[id]/settings',
    roles: 'admin',
  },
  {
    id: 'pr4b',
    label: 'KiloClaw access controls',
    url: '/organizations/[id]/settings?tab=kiloclaw',
    roles: 'admin',
  },
  // (7) Provisioning
  {
    id: 'pr3',
    label: 'New KiloClaw setup',
    url: '/organizations/[id]/claw/new',
    roles: 'both',
  },
  // (8–12) Inside a claw
  {
    id: 'pr2-banners',
    label: 'In-claw status banners',
    url: '/organizations/[id]/claw/* (above every page)',
    roles: 'both',
  },
  {
    id: 'pr2-locks',
    label: 'Access-blocked dialogs',
    url: '/organizations/[id]/claw/* (replaces page when blocked)',
    roles: 'both',
  },
  {
    id: 'pr1',
    label: 'In-claw Subscription tab',
    url: '/organizations/[id]/claw/subscription',
    roles: 'both',
  },
  {
    id: 'wave-c',
    label: 'Instance owner chip',
    url: '/organizations/[id]/claw/settings',
    roles: 'both',
  },
  {
    id: 'pr2-destroy',
    label: 'Destroy confirmation',
    url: '/organizations/[id]/claw/settings',
    roles: 'both',
  },
];

function TableOfContents({ role }: { role: Role }) {
  const visible = TOC_ITEMS.filter(item => visibleForRole(item.roles, role));
  // Plain `<a href="#id">` is unreliable on Next.js App Router client pages,
  // and Safari has long-standing bugs with `window.scrollTo({ behavior: 'smooth' })`
  // when called from a synthetic event handler. Drive the scroll manually with
  // requestAnimationFrame so the behavior is identical across Chrome/Safari/Firefox.
  function handleJump(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
    event.preventDefault();
    const target = document.getElementById(id);
    if (!target) return;

    const offset = 24; // breathing room above the heading
    const scroller = findScrollableAncestor(target);
    const targetTop =
      scroller === window
        ? target.getBoundingClientRect().top + window.scrollY - offset
        : target.getBoundingClientRect().top -
          (scroller as HTMLElement).getBoundingClientRect().top +
          (scroller as HTMLElement).scrollTop -
          offset;

    smoothScrollTo(scroller, targetTop);
    window.history.replaceState(null, '', `#${id}`);
  }
  return (
    <ul className="space-y-1.5 text-sm">
      {visible.map(item => (
        <li key={item.id}>
          <a
            href={`#${item.id}`}
            onClick={event => handleJump(event, item.id)}
            className="text-muted-foreground hover:text-foreground hover:bg-muted block rounded-md px-2 py-1"
          >
            {item.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function findScrollableAncestor(node: HTMLElement): HTMLElement | Window {
  let current: HTMLElement | null = node.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    const isScrollable =
      (overflowY === 'auto' || overflowY === 'scroll') &&
      current.scrollHeight > current.clientHeight;
    if (isScrollable) return current;
    current = current.parentElement;
  }
  return window;
}

function smoothScrollTo(scroller: HTMLElement | Window, top: number) {
  const start = scroller === window ? window.scrollY : (scroller as HTMLElement).scrollTop;
  const distance = top - start;
  if (Math.abs(distance) < 1) return;
  const duration = Math.min(600, Math.max(220, Math.abs(distance) * 0.5));
  const startTime = performance.now();
  function step(now: number) {
    const t = Math.min((now - startTime) / duration, 1);
    // ease-out cubic
    const eased = 1 - Math.pow(1 - t, 3);
    const next = start + distance * eased;
    if (scroller === window) {
      window.scrollTo(0, next);
    } else {
      (scroller as HTMLElement).scrollTop = next;
    }
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function RoleSwitcher({ role, onChange }: { role: Role; onChange: (next: Role) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs uppercase tracking-wide">View as</p>
      <Select value={role} onValueChange={value => onChange(value as Role)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLE_OPTIONS.map(opt => (
            <SelectItem key={opt.value} value={opt.value}>
              <div className="flex flex-col items-start">
                <span className="text-foreground font-medium">{opt.label}</span>
                <span className="text-muted-foreground text-xs">{opt.description}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OrgKcBillingPrototypePage() {
  const [role, setRole] = useState<Role>('admin');

  return (
    <RoleContext.Provider value={role}>
      <div className="bg-background text-foreground min-h-screen">
        <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 py-10 md:px-8 md:py-12">
          <header className="space-y-3 border-b pb-8">
            <p className="text-muted-foreground text-xs uppercase tracking-[0.18em]">
              Design preview
            </p>
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
              Organization KiloClaw billing UI
            </h1>
            <p className="text-muted-foreground max-w-2xl text-sm">
              Preview every UI change planned for organization KiloClaw billing before any code
              ships. Use the role switcher on the left to see what an{' '}
              <span className="text-foreground font-medium">Admin</span> (organization owner or
              billing manager) sees versus a regular{' '}
              <span className="text-foreground font-medium">Member</span>. Admin-only surfaces
              (Organization Settings, the Subscriptions list, the dashboard alert) are hidden in the
              Member view.
            </p>
          </header>

          <div className="grid gap-12 lg:grid-cols-[260px_1fr]">
            <aside className="lg:sticky lg:top-8 lg:h-fit lg:self-start">
              <div className="space-y-6">
                <RoleSwitcher role={role} onChange={setRole} />
                <div>
                  <p className="text-muted-foreground mb-3 text-xs uppercase tracking-wide">
                    Sections
                  </p>
                  <TableOfContents role={role} />
                </div>
              </div>
            </aside>

            <main className="min-w-0 space-y-20">
              {/* (0) Sidebar + dashboard navigation · PR 1 + PR 4a ======================== */}
              <Section
                id="navigation"
                title="Sidebar and dashboard navigation"
                description="Cross-PR navigation deltas. PR 1 adds a 'Subscription' entry under the KiloClaw sub-nav so the new Subscription tab is reachable in one click. PR 4a renames the org-level 'Providers and models' item to 'Settings' (the existing tab is hosted inside the new Settings page) and adds a second 'Organization Settings' CTA on the dashboard alongside the preserved 'Models & Providers' CTA."
                url="/organizations/[id]/* (sidebar) and /organizations/[id] (dashboard)"
              >
                <Variant
                  label="Organization sidebar after both changes"
                  caption="'Settings' replaces 'Providers and models' at the org level. A new 'Subscription' sub-item appears under the KiloClaw section."
                >
                  <SidebarPreview />
                </Variant>
                <Variant
                  label="Organization dashboard CTAs"
                  caption="'Models & Providers' is preserved (deep-links to Settings with the providers tab pre-selected); a new 'Organization Settings' CTA links to the bare Settings page."
                  roles="admin"
                >
                  <DashboardCTAsPreview />
                </Variant>
              </Section>

              {/* (1) Org dashboard — personal banner · Wave B ============================ */}
              <Section
                id="wave-b"
                title="Personal KiloClaw alerts on the Organization dashboard"
                description="A heads-up banner on the Organization dashboard when your own KiloClaw needs attention: trial ending soon, payment failed, or access blocked. Distinct from the dashboard alert tile, which is about all instances in the organization."
                url="/organizations/[id]"
              >
                <Variant
                  label="Healthy · banner hidden"
                  caption="Nothing rendered when your KiloClaw is fine"
                >
                  <OrgKiloClawAssociatedUserBannerPreview status={memberFixtures.available} />
                </Variant>
                <Variant
                  label="Plenty of trial left · banner hidden"
                  caption="23 days left on a 30-day trial; dashboard stays quiet"
                >
                  <OrgKiloClawAssociatedUserBannerPreview status={memberFixtures.trialing30day} />
                </Variant>
                <Variant
                  label="Launch trial ending soon"
                  caption="Within the last 7 days of the 30-day launch trial"
                >
                  <OrgKiloClawAssociatedUserBannerPreview
                    status={{
                      role: 'member',
                      operational: {
                        kind: 'trialing',
                        trialKind: '30day_launch',
                        endsAt: '2026-05-12',
                        daysRemaining: 5,
                      },
                    }}
                  />
                </Variant>
                <Variant
                  label="7-day trial ending soon"
                  caption="Within the last 2 days of a 7-day trial"
                >
                  <OrgKiloClawAssociatedUserBannerPreview
                    status={{
                      role: 'member',
                      operational: {
                        kind: 'trialing',
                        trialKind: '7day_user',
                        endsAt: '2026-05-07',
                        daysRemaining: 1,
                      },
                    }}
                  />
                </Variant>
                <Variant
                  label="Payment failed"
                  caption="Admin sees a Top up credits CTA"
                  roles="admin"
                >
                  <OrgKiloClawAssociatedUserBannerPreview status={adminFixtures.pastDue} />
                </Variant>
                <Variant
                  label="Payment failed"
                  caption="Member is told to contact a billing administrator"
                  roles="member"
                >
                  <OrgKiloClawAssociatedUserBannerPreview status={memberFixtures.pastDue} />
                </Variant>
                <Variant
                  label="Subscription ending"
                  caption="After Destroy was confirmed; instance is gone, sub ends at period end"
                >
                  <OrgKiloClawAssociatedUserBannerPreview status={adminFixtures.canceling} />
                </Variant>
                <Variant
                  label="Organization subscription paused"
                  caption="Admin sees a Manage subscription link"
                  roles="admin"
                >
                  <OrgKiloClawAssociatedUserBannerPreview
                    status={adminFixtures.blockedParentSubEnded}
                  />
                </Variant>
                <Variant
                  label="Organization subscription paused"
                  caption="Member sees an explanation, no action"
                  roles="member"
                >
                  <OrgKiloClawAssociatedUserBannerPreview
                    status={memberFixtures.blockedParentSubEnded}
                  />
                </Variant>
                <Variant
                  label="KiloClaw disabled by your organization"
                  caption="Admin sees a Manage in settings link"
                  roles="admin"
                >
                  <OrgKiloClawAssociatedUserBannerPreview status={adminFixtures.blockedOptOut} />
                </Variant>
                <Variant
                  label="KiloClaw disabled by your organization"
                  caption="Member sees an explanation, no action"
                  roles="member"
                >
                  <OrgKiloClawAssociatedUserBannerPreview status={memberFixtures.blockedOptOut} />
                </Variant>

                <Variant
                  label="Both alerts on the same dashboard"
                  caption="Admin who is also associated user: their own KiloClaw failed, and other instances also need triage. The personal banner addresses their own problem; the alert tile shows the org-wide problem."
                  roles="admin"
                >
                  <OrgDashboardWithBannerAndTile
                    status={adminFixtures.pastDue}
                    summary={healthSummaryFixtures.pastDueOnly}
                  />
                </Variant>
              </Section>

              {/* (2) Org dashboard — admin alert tile · Wave A ============================ */}
              <Section
                id="wave-a-tile"
                title="Dashboard alert when subscriptions need attention"
                description="A warning tile on the Organization dashboard that surfaces past-due, suspended, or org-canceled KiloClaw subscriptions. Hidden when everything is healthy. Visible only to organization owners and billing managers."
                url="/organizations/[id]"
                roles="admin"
              >
                <Variant
                  label="Healthy organization"
                  caption="Tile is hidden when no subscription needs attention"
                >
                  <div className="text-muted-foreground rounded-xl border border-dashed p-4 text-sm">
                    Tile is hidden. (Nothing renders.)
                  </div>
                </Variant>
                <Variant label="Some instances past due">
                  <OrgKiloClawAlertTilePreview summary={healthSummaryFixtures.pastDueOnly} />
                </Variant>
                <Variant label="Mixed issues across instances">
                  <OrgKiloClawAlertTilePreview summary={healthSummaryFixtures.multipleIssues} />
                </Variant>
              </Section>

              {/* (3) Subscriptions page — KiloClaw section · Wave A ======================= */}
              <Section
                id="wave-a-group"
                title="KiloClaw section on the Subscriptions page"
                description="All KiloClaw instances for the organization, listed alongside seats on the Subscriptions page. Each row links to its individual subscription detail page."
                url="/organizations/[id]/subscriptions"
                roles="admin"
              >
                <Variant
                  label="With instances · hiding canceled"
                  caption="Default; only active subscriptions shown"
                >
                  <OrgKiloClawGroupPreview rows={subscriptionRowsFixture} showTerminal={false} />
                </Variant>
                <Variant
                  label="With instances · showing canceled"
                  caption="After clicking the Show terminal toggle"
                >
                  <OrgKiloClawGroupPreview rows={subscriptionRowsFixture} showTerminal={true} />
                </Variant>
                <Variant
                  label="No instances yet"
                  caption="Empty state with a Provision KiloClaw link"
                >
                  <OrgKiloClawGroupPreview rows={[]} showTerminal={true} />
                </Variant>
              </Section>

              {/* (4) Subscription detail page · Wave A ==================================== */}
              <Section
                id="wave-a-detail"
                title="Individual subscription detail page"
                description="Detailed view of a single KiloClaw subscription: plan, pricing, renewal date, the member it's associated with, and the billing history. Reachable from the Subscriptions page. Read-only here; lifecycle actions (start, stop, destroy) live on the KiloClaw Settings page."
                url="/organizations/[id]/subscriptions/kiloclaw/[instanceId]"
                roles="admin"
              >
                <Variant label="Active subscription">
                  <OrgKiloClawDetailPreview
                    row={detailRowFixtures.active}
                    history={billingHistoryFixture}
                  />
                </Variant>
                <Variant label="On the 30-day launch trial">
                  <OrgKiloClawDetailPreview
                    row={detailRowFixtures.trialing30day}
                    history={billingHistoryFixture}
                  />
                </Variant>
                <Variant label="On a 7-day free trial">
                  <OrgKiloClawDetailPreview
                    row={detailRowFixtures.trialing7day}
                    history={billingHistoryFixture}
                  />
                </Variant>
                <Variant label="Payment failed">
                  <OrgKiloClawDetailPreview
                    row={detailRowFixtures.pastDue}
                    history={billingHistoryFixture}
                  />
                </Variant>
                <Variant label="Subscription ending">
                  <OrgKiloClawDetailPreview
                    row={detailRowFixtures.canceling}
                    history={billingHistoryFixture}
                  />
                </Variant>
                <Variant
                  label="Organization subscription ended"
                  caption="Status note explains the org-level cause; admins act on the org subscription, not on this instance"
                >
                  <OrgKiloClawDetailPreview
                    row={detailRowFixtures.blockedParentSubEnded}
                    history={billingHistoryFixture}
                  />
                </Variant>
                <Variant
                  label="Organization trial expired"
                  caption="Different blocking reason, different copy in the status note"
                >
                  <OrgKiloClawDetailPreview
                    row={detailRowFixtures.blockedParentTrialExpired}
                    history={billingHistoryFixture}
                  />
                </Variant>
                <Variant
                  label="Disabled by your organization"
                  caption="Yellow note rather than red — admin-controlled, reversible from settings"
                >
                  <OrgKiloClawDetailPreview
                    row={detailRowFixtures.blockedOptOut}
                    history={billingHistoryFixture}
                  />
                </Variant>
              </Section>

              {/* (5) Organization Settings · PR 4a ======================================== */}
              <Section
                id="pr4a"
                title="Organization Settings (with new tabs)"
                description="The existing 'Providers and models' page becomes a tab inside a new Organization Settings page. The KiloClaw access controls (next section) slot in as a second tab. The default landing tab is preserved so existing links keep working."
                url="/organizations/[id]/settings"
                roles="admin"
              >
                <Variant label="Settings page with the new tabs">
                  <OptOutTabClient plan="enterprise" wrapInTabs />
                </Variant>
              </Section>

              {/* (6) KiloClaw access controls · PR 4b ===================================== */}
              <Section
                id="pr4b"
                title="KiloClaw access controls (Enterprise only)"
                description="An Enterprise-only setting that lets organization owners disable KiloClaw for everyone in their organization. On Teams plans the tab shows an Enterprise upgrade prompt instead."
                url="/organizations/[id]/settings?tab=kiloclaw"
                roles="admin"
              >
                <Variant
                  label="Enterprise plan · the toggle is interactive"
                  caption="Click the switch to see the confirmation dialog"
                >
                  <OptOutTabClient plan="enterprise" />
                </Variant>
                <Variant label="Teams plan · Enterprise upgrade prompt">
                  <OptOutTabClient plan="teams" />
                </Variant>
              </Section>

              {/* (7) New KiloClaw setup · PR 3 ============================================ */}
              <Section
                id="pr3"
                title="New KiloClaw setup"
                description="What members and admins see when starting a new KiloClaw instance for the organization. The setup wizard checks for blocking issues (no organization subscription, no credits, KiloClaw disabled, or you already have one) before letting you continue."
                url="/organizations/[id]/claw/new"
              >
                <Variant label="Checking eligibility…">
                  <OrgProvisionPreflightLoading />
                </Variant>
                <Variant label="Something went wrong">
                  <OrgProvisionPreflightError />
                </Variant>
                <Variant
                  label="Eligible · 7-day free trial available"
                  caption="Admin sees the renewal cost and current organization credit balance"
                  roles="admin"
                >
                  <OrgProvisionPreflightPreview
                    preflight={preflightFixtures.adminAllowedTrialEligible}
                  />
                </Variant>
                <Variant
                  label="Eligible · no free trial"
                  caption="Already had a KiloClaw in this organization before"
                  roles="admin"
                >
                  <OrgProvisionPreflightPreview preflight={preflightFixtures.adminAllowedNoTrial} />
                </Variant>
                <Variant
                  label="Eligible · 7-day free trial available"
                  caption="Members don't see organization credit balances or pricing"
                  roles="member"
                >
                  <OrgProvisionPreflightPreview
                    preflight={preflightFixtures.memberAllowedTrialEligible}
                  />
                </Variant>
                <Variant
                  label="Eligible · no free trial"
                  caption="Already had a KiloClaw in this organization before; member sees a no-trial copy variant"
                  roles="member"
                >
                  <OrgProvisionPreflightPreview
                    preflight={preflightFixtures.memberAllowedNoTrial}
                  />
                </Variant>
                <Variant
                  label="Blocked: no organization subscription"
                  caption="Org never had a subscription"
                  roles="admin"
                >
                  <OrgProvisionPreflightPreview preflight={preflightFixtures.blockedParentNoSub} />
                </Variant>
                <Variant
                  label="Blocked: organization trial expired"
                  caption="Org never converted from trial to paid"
                  roles="admin"
                >
                  <OrgProvisionPreflightPreview
                    preflight={preflightFixtures.blockedParentTrialExpired}
                  />
                </Variant>
                <Variant
                  label="Blocked: organization subscription ended"
                  caption="Member sees an explanation, no action"
                  roles="member"
                >
                  <OrgProvisionPreflightPreview
                    preflight={preflightFixtures.blockedParentSubEnded}
                  />
                </Variant>
                <Variant
                  label="Blocked: KiloClaw disabled by your organization"
                  caption="Admin sees a Manage in settings link"
                  roles="admin"
                >
                  <OrgProvisionPreflightPreview preflight={preflightFixtures.blockedOptOutAdmin} />
                </Variant>
                <Variant
                  label="Blocked: KiloClaw disabled by your organization"
                  caption="Member sees an explanation, no action"
                  roles="member"
                >
                  <OrgProvisionPreflightPreview preflight={preflightFixtures.blockedOptOutMember} />
                </Variant>
                <Variant
                  label="Blocked: you already have a KiloClaw"
                  caption="Each member can have one organization KiloClaw at a time"
                >
                  <OrgProvisionPreflightPreview
                    preflight={preflightFixtures.blockedExistingInstance}
                  />
                </Variant>
                <Variant
                  label="Blocked: not enough organization credits"
                  caption="Admin sees the shortfall, current balance, and cost"
                  roles="admin"
                >
                  <OrgProvisionPreflightPreview
                    preflight={preflightFixtures.blockedInsufficientCreditsAdmin}
                  />
                </Variant>
                <Variant
                  label="Blocked: not enough organization credits"
                  caption="Member is routed to ask a billing administrator"
                  roles="member"
                >
                  <OrgProvisionPreflightPreview
                    preflight={preflightFixtures.blockedInsufficientCreditsMember}
                  />
                </Variant>
              </Section>

              {/* (8) In-claw status banners · PR 2 ======================================== */}
              <Section
                id="pr2-banners"
                title="Status banners (across all KiloClaw pages)"
                description="Heads-up banner shown above every KiloClaw page (Chat, Subscription, Settings) when there's something the user should know: trial ending, payment failed, or access blocked. Hidden when everything is fine."
                url="/organizations/[id]/claw/* (above every page)"
              >
                <Variant
                  label="On the 30-day launch trial"
                  caption="More than 3 days left, calm informational tone"
                >
                  <OrgBillingBannerPreview status={adminFixtures.trialing30day} />
                </Variant>
                <Variant label="On a 7-day free trial" caption="5 days left, still informational">
                  <OrgBillingBannerPreview status={adminFixtures.trialing7day} />
                </Variant>
                <Variant label="Trial ending in 3 days" caption="Tone shifts to yellow">
                  <OrgBillingBannerPreview
                    status={{
                      role: 'admin',
                      operational: {
                        kind: 'trialing',
                        trialKind: '7day_user',
                        endsAt: '2026-05-09',
                        daysRemaining: 3,
                      },
                      subscription: adminFixtures.trialing7day.subscription,
                      org: adminFixtures.trialing7day.org,
                    }}
                  />
                </Variant>
                <Variant label="Trial ending tomorrow" caption="Tone shifts to red">
                  <OrgBillingBannerPreview
                    status={{
                      role: 'admin',
                      operational: {
                        kind: 'trialing',
                        trialKind: '7day_user',
                        endsAt: '2026-05-07',
                        daysRemaining: 1,
                      },
                      subscription: adminFixtures.trialing7day.subscription,
                      org: adminFixtures.trialing7day.org,
                    }}
                  />
                </Variant>
                <Variant label="Trial ending today" caption="Last-call urgency">
                  <OrgBillingBannerPreview
                    status={{
                      role: 'admin',
                      operational: {
                        kind: 'trialing',
                        trialKind: '7day_user',
                        endsAt: '2026-05-06',
                        daysRemaining: 0,
                      },
                      subscription: adminFixtures.trialing7day.subscription,
                      org: adminFixtures.trialing7day.org,
                    }}
                  />
                </Variant>
                <Variant
                  label="Payment failed"
                  caption="Admin sees a Top up credits CTA"
                  roles="admin"
                >
                  <OrgBillingBannerPreview status={adminFixtures.pastDue} />
                </Variant>
                <Variant
                  label="Payment failed"
                  caption="Member is told to contact a billing administrator"
                  roles="member"
                >
                  <OrgBillingBannerPreview status={memberFixtures.pastDue} />
                </Variant>
                <Variant label="Subscription ending" caption="After Destroy was confirmed">
                  <OrgBillingBannerPreview status={adminFixtures.canceling} />
                </Variant>
                <Variant
                  label="Organization subscription paused"
                  caption="Admin sees a Manage subscription link"
                  roles="admin"
                >
                  <OrgBillingBannerPreview status={adminFixtures.blockedParentSubEnded} />
                </Variant>
                <Variant
                  label="Organization subscription paused"
                  caption="Member sees an explanation, no action"
                  roles="member"
                >
                  <OrgBillingBannerPreview status={memberFixtures.blockedParentSubEnded} />
                </Variant>
                <Variant
                  label="KiloClaw disabled by your organization"
                  caption="Admin sees a Manage in settings link"
                  roles="admin"
                >
                  <OrgBillingBannerPreview status={adminFixtures.blockedOptOut} />
                </Variant>
                <Variant
                  label="KiloClaw disabled by your organization"
                  caption="Member sees an explanation, no action"
                  roles="member"
                >
                  <OrgBillingBannerPreview status={memberFixtures.blockedOptOut} />
                </Variant>
              </Section>

              {/* (9) Access-blocked dialogs · PR 2 ======================================== */}
              <Section
                id="pr2-locks"
                title="Access-blocked dialogs"
                description="Full-screen modal that takes over a KiloClaw page when access is blocked: the payment grace period elapsed and the instance is suspended, the organization subscription is paused, or KiloClaw was disabled by an admin."
                url="/organizations/[id]/claw/* (replaces page when blocked)"
              >
                <Variant
                  label="Suspended after the payment grace period"
                  caption="Admin sees a Top up credits CTA"
                  roles="admin"
                >
                  <OrgAccessLockedDialogPreview status={adminFixtures.pastDueSuspended} />
                </Variant>
                <Variant
                  label="Suspended after the payment grace period"
                  caption="Member is told to contact a billing administrator"
                  roles="member"
                >
                  <OrgAccessLockedDialogPreview status={memberFixtures.pastDueSuspended} />
                </Variant>
                <Variant
                  label="Organization subscription paused"
                  caption="Admin sees a Manage subscription link"
                  roles="admin"
                >
                  <OrgAccessLockedDialogPreview status={adminFixtures.blockedParentSubEnded} />
                </Variant>
                <Variant
                  label="Organization subscription paused"
                  caption="Member sees an explanation, no action"
                  roles="member"
                >
                  <OrgAccessLockedDialogPreview status={memberFixtures.blockedParentSubEnded} />
                </Variant>
                <Variant
                  label="KiloClaw disabled by your organization"
                  caption="Admin sees a Manage in settings link"
                  roles="admin"
                >
                  <OrgAccessLockedDialogPreview status={adminFixtures.blockedOptOut} />
                </Variant>
                <Variant
                  label="KiloClaw disabled by your organization"
                  caption="Member sees an explanation, no action"
                  roles="member"
                >
                  <OrgAccessLockedDialogPreview status={memberFixtures.blockedOptOut} />
                </Variant>
              </Section>

              {/* (10) In-claw Subscription tab · PR 1 ===================================== */}
              <Section
                id="pr1"
                title="KiloClaw Subscription page"
                description="What members and admins see on the Subscription tab inside an organization's KiloClaw. Each variant covers a different subscription state: active, on trial, past due, blocked, and so on."
                url="/organizations/[id]/claw/subscription"
              >
                <Variant label="Before anyone has provisioned KiloClaw" roles="admin">
                  <OrgSubscriptionPagePreview status={adminFixtures.emptyState} />
                </Variant>
                <Variant label="Active subscription" roles="admin">
                  <OrgSubscriptionPagePreview status={adminFixtures.active} />
                </Variant>
                <Variant
                  label="On the 30-day launch trial"
                  caption="23 of 30 days left"
                  roles="admin"
                >
                  <OrgSubscriptionPagePreview status={adminFixtures.trialing30day} />
                </Variant>
                <Variant label="On a 7-day free trial" caption="5 of 7 days left" roles="admin">
                  <OrgSubscriptionPagePreview status={adminFixtures.trialing7day} />
                </Variant>
                <Variant
                  label="Payment failed"
                  caption="Within the grace period; instance still running"
                  roles="admin"
                >
                  <OrgSubscriptionPagePreview status={adminFixtures.pastDue} />
                </Variant>
                <Variant
                  label="Subscription ending"
                  caption="Instance was destroyed; subscription continues until the period ends"
                  roles="admin"
                >
                  <OrgSubscriptionPagePreview status={adminFixtures.canceling} />
                </Variant>
                <Variant
                  label="Organization subscription ended"
                  caption="Org-level subscription cancelled; KiloClaw paused for everyone"
                  roles="admin"
                >
                  <OrgSubscriptionPagePreview status={adminFixtures.blockedParentSubEnded} />
                </Variant>
                <Variant
                  label="Organization trial expired"
                  caption="Org never converted from trial to paid; KiloClaw paused for everyone"
                  roles="admin"
                >
                  <OrgSubscriptionPagePreview status={adminFixtures.blockedParentTrialExpired} />
                </Variant>
                <Variant
                  label="Disabled by your organization"
                  caption="An owner turned KiloClaw off in Organization Settings"
                  roles="admin"
                >
                  <OrgSubscriptionPagePreview status={adminFixtures.blockedOptOut} />
                </Variant>

                <Variant label="Active" roles="member">
                  <OrgSubscriptionPagePreview status={memberFixtures.available} />
                </Variant>
                <Variant
                  label="On the 30-day launch trial"
                  caption="23 of 30 days left"
                  roles="member"
                >
                  <OrgSubscriptionPagePreview status={memberFixtures.trialing30day} />
                </Variant>
                <Variant label="On a 7-day free trial" caption="5 of 7 days left" roles="member">
                  <OrgSubscriptionPagePreview status={memberFixtures.trialing7day} />
                </Variant>
                <Variant label="Payment failed" roles="member">
                  <OrgSubscriptionPagePreview status={memberFixtures.pastDue} />
                </Variant>
                <Variant label="Subscription ending" roles="member">
                  <OrgSubscriptionPagePreview status={memberFixtures.canceling} />
                </Variant>
                <Variant label="Organization subscription paused" roles="member">
                  <OrgSubscriptionPagePreview status={memberFixtures.blockedParentSubEnded} />
                </Variant>
                <Variant label="Disabled by your organization" roles="member">
                  <OrgSubscriptionPagePreview status={memberFixtures.blockedOptOut} />
                </Variant>
              </Section>

              {/* (11) Settings page — instance owner chip · Wave C ======================== */}
              <Section
                id="wave-c"
                title="Instance owner chip on the Settings page"
                description="A small line under the instance name on the KiloClaw Settings page showing which member of the organization the instance belongs to. Only shown for organization KiloClaw instances; the personal KiloClaw is, by definition, yours."
                url="/organizations/[id]/claw/settings"
              >
                <Variant
                  label="Chip alone · viewing someone else's instance"
                  caption="An admin opened a member's KiloClaw Settings page from the Subscriptions page"
                  roles="admin"
                >
                  <AssociatedUserChip
                    associatedUser={associatedUserFixtures.someoneElse}
                    currentUserId={VIEWER_USER_ID}
                  />
                </Variant>
                <Variant
                  label="Chip alone · viewing your own instance"
                  caption='Adds a "(you)" suffix when the viewer matches the associated user'
                >
                  <AssociatedUserChip
                    associatedUser={associatedUserFixtures.yourself}
                    currentUserId={VIEWER_USER_ID}
                  />
                </Variant>
                <Variant
                  label="Chip alone · personal KiloClaw"
                  caption="Outside an organization, the chip renders nothing"
                >
                  <div className="text-muted-foreground rounded-xl border border-dashed p-4 text-sm">
                    Nothing rendered. The personal KiloClaw doesn't show an owner chip.
                  </div>
                </Variant>
                <Variant
                  label="Inside the Settings page header · someone else's instance"
                  caption="Slots between the instance name and the Instance Controls section"
                  roles="admin"
                >
                  <InstanceControlsHeaderPreview
                    associatedUser={associatedUserFixtures.someoneElse}
                    currentUserId={VIEWER_USER_ID}
                  />
                </Variant>
                <Variant label="Inside the Settings page header · your own instance">
                  <InstanceControlsHeaderPreview
                    associatedUser={associatedUserFixtures.yourself}
                    currentUserId={VIEWER_USER_ID}
                  />
                </Variant>
              </Section>

              {/* (12) Settings page — destroy confirmation · PR 2 ========================= */}
              <Section
                id="pr2-destroy"
                title="Destroy confirmation"
                description="Confirmation shown before destroying a KiloClaw instance from the Settings page. An extra bullet appears when the instance is still on the 30-day launch-period free trial."
                url="/organizations/[id]/claw/settings (when clicking Destroy)"
              >
                <Variant label="Standard destroy">
                  <OrgDestroyConfirmDialogPreview
                    isLaunchBackfill={false}
                    currentPeriodEnd="2026-06-12"
                  />
                </Variant>
                <Variant
                  label="Destroy while still on the launch trial"
                  caption="Extra warning: destroying forfeits the remaining trial credit"
                >
                  <OrgDestroyConfirmDialogPreview
                    isLaunchBackfill={true}
                    currentPeriodEnd="2026-06-05"
                  />
                </Variant>
              </Section>
            </main>
          </div>

          <footer className="border-t pt-8">
            <p className="text-muted-foreground text-xs">
              Preview only · mock data, no real subscriptions. The canonical implementation plan
              lives at <code className="font-mono">.plans/org-kiloclaw-billing-ui.md</code>.
            </p>
          </footer>
        </div>
      </div>
    </RoleContext.Provider>
  );
}

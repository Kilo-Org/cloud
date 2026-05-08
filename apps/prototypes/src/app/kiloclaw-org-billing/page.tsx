/**
 * Prototype page for Organization KiloClaw billing UI.
 *
 * Renders every component proposed in `.plans/org-kiloclaw-billing-ui.md`
 * with mock data so the design can be reviewed before implementation.
 *
 * Route: /kiloclaw-org-billing
 *
 * Not gated by auth or org context — purely for design review. Delete this
 * directory once implementation begins, or keep as a living spec preview.
 */

'use client';

import { createContext, useContext, useState } from 'react';
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
  kiloAdminChangeLogFixture,
  kiloAdminKiloclawInstanceRowsFixture,
  kiloAdminKiloclawStatsFixture,
  kiloAdminOrgSupportFixture,
  kiloAdminUserSupportFixture,
  memberFixtures,
  preflightFixtures,
  subscriptionRowsFixture,
  VIEWER_USER_ID,
} from './mock-data';
import {
  AssociatedUserChip,
  DashboardCTAsPreview,
  InstanceControlsHeaderPreview,
  KiloAdminInstanceBillingSupportPreview,
  KiloAdminKiloclawListPreview,
  KiloAdminMutationSafetyPreview,
  KiloAdminOrganizationKiloclawPreview,
  KiloAdminUserKiloclawPreview,
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
import {
  createPrototypeReviewModel,
  isPrototypeVisible,
  PrototypePageShell,
  PrototypeSection,
  PrototypeTableOfContents,
  PrototypeVariant,
  type PrototypeVisibility,
} from '@/components/prototype-kit';
import { OptOutTabClient } from './opt-out-client';
import roleSwitcherStyles from './role-switcher.module.css';

// ---------------------------------------------------------------------------
// Role filter
// ---------------------------------------------------------------------------

type Role = 'admin' | 'member' | 'kilo_admin';
type RoleVisibility = PrototypeVisibility<Role>;

const CUSTOMER_ROLES = ['admin', 'member'] as const satisfies readonly Role[];
const RoleContext = createContext<Role>('admin');

function roleVisibilityLabel(roles: Role): string {
  const labels: Record<Role, string> = {
    admin: 'Admin',
    member: 'Member',
    kilo_admin: 'Kilo Admin',
  };
  return labels[roles];
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
  {
    value: 'kilo_admin',
    label: 'Kilo Admin',
    description: 'Internal support and ops',
  },
];

// ---------------------------------------------------------------------------
// Route-specific role gates around shared prototype-kit primitives
// ---------------------------------------------------------------------------

function Section({
  id,
  title,
  description,
  url,
  roles = CUSTOMER_ROLES,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  url: string;
  roles?: RoleVisibility;
  children: React.ReactNode;
}) {
  const role = useContext(RoleContext);
  const visibilityLabel =
    typeof roles === 'string' && roles !== 'all' ? `${roleVisibilityLabel(roles)} only` : undefined;

  return (
    <PrototypeSection
      id={id}
      title={title}
      description={description}
      url={url}
      visible={isPrototypeVisible(roles, role)}
      visibilityLabel={visibilityLabel}
    >
      {children}
    </PrototypeSection>
  );
}

function Variant({
  label,
  caption,
  roles = 'all',
  children,
}: {
  label: string;
  caption?: string;
  roles?: RoleVisibility;
  children: React.ReactNode;
}) {
  const role = useContext(RoleContext);

  return (
    <PrototypeVariant label={label} caption={caption} visible={isPrototypeVisible(roles, role)}>
      {children}
    </PrototypeVariant>
  );
}

// ---------------------------------------------------------------------------
// TOC — role-aware
// ---------------------------------------------------------------------------

// Ordered by selected role. Customer roles follow the product journey;
// Kilo Admin follows internal support triage from list → detail → org/user support.
const REVIEW_SECTIONS: {
  id: string;
  label: string;
  title: string;
  url: string;
  visibility: RoleVisibility;
}[] = [
  // Kilo Admin — internal support and ops surfaces
  {
    id: 'admin-kiloclaw-list',
    label: 'Admin KiloClaw list and filters',
    title: 'Admin KiloClaw list and filters',
    url: '/admin/kiloclaw',
    visibility: 'kilo_admin',
  },
  {
    id: 'admin-kiloclaw-detail',
    label: 'Instance billing support card',
    title: 'Instance billing support card',
    url: '/admin/kiloclaw/[id]',
    visibility: 'kilo_admin',
  },
  {
    id: 'admin-mutation-safety',
    label: 'Admin mutation guardrails',
    title: 'Admin mutation guardrails',
    url: '/admin/kiloclaw/[id] and /admin/users/[id]?tab=kiloclaw',
    visibility: 'kilo_admin',
  },
  {
    id: 'admin-org-support',
    label: 'Organization support KiloClaw section',
    title: 'Organization support KiloClaw section',
    url: '/admin/organizations/[id]',
    visibility: 'kilo_admin',
  },
  {
    id: 'admin-user-support',
    label: 'User support KiloClaw tab',
    title: 'User support KiloClaw tab',
    url: '/admin/users/[id]?tab=kiloclaw',
    visibility: 'kilo_admin',
  },
  // (0) Cross-PR navigation surfaces
  {
    id: 'navigation',
    label: 'Sidebar and dashboard navigation',
    title: 'Sidebar and dashboard navigation',
    url: '/organizations/[id]/* (sidebar) and /organizations/[id] (dashboard)',
    visibility: CUSTOMER_ROLES,
  },
  // (1–2) Org dashboard
  {
    id: 'wave-b',
    label: 'Personal KiloClaw alerts on dashboard',
    title: 'Personal KiloClaw alerts on dashboard',
    url: '/organizations/[id]',
    visibility: CUSTOMER_ROLES,
  },
  {
    id: 'wave-a-tile',
    label: 'Dashboard subscription alert',
    title: 'Dashboard subscription alert',
    url: '/organizations/[id]',
    visibility: 'admin',
  },
  // (3–4) Org Subscriptions page
  {
    id: 'wave-a-group',
    label: 'KiloClaw on the Subscriptions page',
    title: 'KiloClaw on the Subscriptions page',
    url: '/organizations/[id]/subscriptions',
    visibility: 'admin',
  },
  {
    id: 'wave-a-detail',
    label: 'Subscription detail page',
    title: 'Subscription detail page',
    url: '/organizations/[id]/subscriptions/kiloclaw/[instanceId]',
    visibility: 'admin',
  },
  // (5–6) Org Settings
  {
    id: 'pr4a',
    label: 'Organization settings',
    title: 'Organization settings',
    url: '/organizations/[id]/settings',
    visibility: 'admin',
  },
  {
    id: 'pr4b',
    label: 'KiloClaw access controls',
    title: 'KiloClaw access controls',
    url: '/organizations/[id]/settings?tab=kiloclaw',
    visibility: 'admin',
  },
  // (7) Provisioning
  {
    id: 'pr3',
    label: 'New KiloClaw setup',
    title: 'New KiloClaw setup',
    url: '/organizations/[id]/claw/new',
    visibility: CUSTOMER_ROLES,
  },
  // (8–12) Inside a claw
  {
    id: 'pr2-banners',
    label: 'In-claw status banners',
    title: 'In-claw status banners',
    url: '/organizations/[id]/claw/* (above every page)',
    visibility: CUSTOMER_ROLES,
  },
  {
    id: 'pr2-locks',
    label: 'Access-blocked dialogs',
    title: 'Access-blocked dialogs',
    url: '/organizations/[id]/claw/* (replaces page when blocked)',
    visibility: CUSTOMER_ROLES,
  },
  {
    id: 'pr1',
    label: 'In-claw Subscription tab',
    title: 'In-claw Subscription tab',
    url: '/organizations/[id]/claw/subscription',
    visibility: CUSTOMER_ROLES,
  },
  {
    id: 'wave-c',
    label: 'Instance owner chip',
    title: 'Instance owner chip',
    url: '/organizations/[id]/claw/settings',
    visibility: CUSTOMER_ROLES,
  },
  {
    id: 'pr2-destroy',
    label: 'Destroy confirmation',
    title: 'Destroy confirmation',
    url: '/organizations/[id]/claw/settings',
    visibility: CUSTOMER_ROLES,
  },
];

function TableOfContents({ role }: { role: Role }) {
  const review = createPrototypeReviewModel({ currentView: role, sections: REVIEW_SECTIONS });
  return <PrototypeTableOfContents items={review.tocItems} />;
}

function RoleSwitcher({ role, onChange }: { role: Role; onChange: (next: Role) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs uppercase tracking-wide">View as</p>
      <Select value={role} onValueChange={value => onChange(value as Role)}>
        <SelectTrigger className={roleSwitcherStyles.trigger}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={roleSwitcherStyles.content}>
          {ROLE_OPTIONS.map(opt => (
            <SelectItem
              key={opt.value}
              value={opt.value}
              textValue={opt.label}
              className={roleSwitcherStyles.item}
            >
              <div className={roleSwitcherStyles.itemText}>
                <span className={roleSwitcherStyles.label}>{opt.label}</span>
                <span className={roleSwitcherStyles.description}>{opt.description}</span>
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
      <PrototypePageShell
        eyebrow="Design preview"
        title="Organization KiloClaw billing UI"
        description={
          <p>
            Preview every UI change planned for organization KiloClaw billing before any code ships.
            Use the role switcher on the left to compare customer-facing{' '}
            <span className="text-foreground font-medium">Admin</span> and{' '}
            <span className="text-foreground font-medium">Member</span> surfaces, or switch to{' '}
            <span className="text-foreground font-medium">Kilo Admin</span> for the internal support
            and launch-readiness sections from{' '}
            <code className="font-mono">.plans/org-kiloclaw-billing-admin.md</code>.
          </p>
        }
        sidebar={
          <div className="space-y-6">
            <RoleSwitcher role={role} onChange={setRole} />
            <div>
              <p className="text-muted-foreground mb-3 text-xs uppercase tracking-wide">Sections</p>
              <TableOfContents role={role} />
            </div>
          </div>
        }
        footer={
          <p className="text-muted-foreground text-xs">
            Preview only · mock data, no real subscriptions. The canonical implementation plan lives
            at <code className="font-mono">.plans/org-kiloclaw-billing-ui.md</code>.
          </p>
        }
      >
        {/* Kilo Admin · P0/P1/P2 support and ops surfaces ========================== */}
        <Section
          id="admin-kiloclaw-list"
          title="Admin KiloClaw list and filters"
          description="P0 support-readiness view for /admin/kiloclaw: keeps the existing stats, chart, search, filters, bulk selection, version controls, sorting, pagination, and row navigation, then adds org billing context."
          url="/admin/kiloclaw"
          roles="kilo_admin"
        >
          <Variant label="Org-billing-aware instance list">
            <KiloAdminKiloclawListPreview
              rows={kiloAdminKiloclawInstanceRowsFixture}
              stats={kiloAdminKiloclawStatsFixture}
            />
          </Variant>
        </Section>

        <Section
          id="admin-kiloclaw-detail"
          title="Instance billing support card"
          description="P0 detail-page support card for /admin/kiloclaw/[id]. Keeps existing instance information and destructive/runtime controls, then adds normalized org billing state, org funding, parent entitlement, Enterprise opt-out, IDs, links, and change-log access."
          url="/admin/kiloclaw/[id]"
          roles="kilo_admin"
        >
          <Variant
            label="Suspended org instance"
            caption="Support can see why access is blocked and which org-owned funding path failed."
          >
            <KiloAdminInstanceBillingSupportPreview
              row={kiloAdminKiloclawInstanceRowsFixture[3]}
              changeLogs={kiloAdminChangeLogFixture}
            />
          </Variant>
          <Variant
            label="Enterprise opt-out blocked"
            caption="The local subscription is active, but enforced Enterprise opt-out blocks access and renewal."
          >
            <KiloAdminInstanceBillingSupportPreview
              row={kiloAdminKiloclawInstanceRowsFixture[6]}
              changeLogs={kiloAdminChangeLogFixture}
            />
          </Variant>
        </Section>

        <Section
          id="admin-mutation-safety"
          title="Admin mutation guardrails"
          description="P0 hardening for admin trial/cancel/destroy controls so personal-only actions cannot silently mutate org-funded subscriptions."
          url="/admin/kiloclaw/[id] and /admin/users/[id]?tab=kiloclaw"
          roles="kilo_admin"
        >
          <Variant label="Org row action states">
            <KiloAdminMutationSafetyPreview />
          </Variant>
        </Section>

        <Section
          id="admin-org-support"
          title="Organization support KiloClaw section"
          description="P1 organization admin page section: aggregate org KC health, active instances, trial split, opt-out value, total renewal cost, credit balance, and per-instance links."
          url="/admin/organizations/[id]"
          roles="kilo_admin"
        >
          <Variant label="Organization-level support card">
            <KiloAdminOrganizationKiloclawPreview summary={kiloAdminOrgSupportFixture} />
          </Variant>
        </Section>

        <Section
          id="admin-user-support"
          title="User support KiloClaw tab"
          description="P1 user admin tab updates: personal and organization KiloClaw rows stay separate, org rows show org funding and disable personal-only actions."
          url="/admin/users/[id]?tab=kiloclaw"
          roles="kilo_admin"
        >
          <Variant label="User tab with separated personal and org rows">
            <KiloAdminUserKiloclawPreview summary={kiloAdminUserSupportFixture} />
          </Variant>
        </Section>

        {/* (0) Sidebar + dashboard navigation · PR 1 + PR 4a ======================== */}
        <Section
          id="navigation"
          title="Sidebar and dashboard navigation"
          description="Cross-PR navigation deltas. PR 1 adds a 'Subscription' entry under the KiloClaw sub-nav so the new Subscription tab is reachable in one click. PR 4a renames the org-level 'Providers and models' item to 'Settings' (the existing tab is hosted inside the new Settings page) and adds a second 'KiloClaw Settings' CTA on the dashboard alongside the preserved 'Models & Providers' CTA."
          url="/organizations/[id]/* (sidebar) and /organizations/[id] (dashboard)"
        >
          <Variant
            label="Organization sidebar after both changes"
            caption={
              role === 'member'
                ? 'Members see KiloClaw navigation, but not org Subscriptions or org Settings.'
                : "'Settings' replaces 'Providers and models' at the org level. A new 'Subscription' sub-item appears under the KiloClaw section."
            }
          >
            <SidebarPreview role={role === 'member' ? 'member' : 'admin'} />
          </Variant>
          <Variant
            label="Organization dashboard CTAs"
            caption="'Models & Providers' is preserved (deep-links to Settings with the providers tab pre-selected); a new 'KiloClaw Settings' CTA links to the KiloClaw tab."
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
          <Variant label="Payment failed" caption="Admin sees a Top up credits CTA" roles="admin">
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
            <OrgKiloClawAssociatedUserBannerPreview status={adminFixtures.blockedParentSubEnded} />
          </Variant>
          <Variant
            label="Organization subscription paused"
            caption="Member sees an explanation, no action"
            roles="member"
          >
            <OrgKiloClawAssociatedUserBannerPreview status={memberFixtures.blockedParentSubEnded} />
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
          <Variant label="No instances yet" caption="Empty state with a Provision KiloClaw link">
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
            caption="Yellow note rather than red, admin-controlled and reversible from settings"
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
          title="Organization settings (with new tabs)"
          description="The existing 'Providers and models' page becomes a tab inside a new organization settings page. The KiloClaw access controls (next section) slot in as a second tab. The default landing tab is preserved so existing links keep working."
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
            <OrgProvisionPreflightPreview preflight={preflightFixtures.adminAllowedTrialEligible} />
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
            <OrgProvisionPreflightPreview preflight={preflightFixtures.memberAllowedNoTrial} />
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
            <OrgProvisionPreflightPreview preflight={preflightFixtures.blockedParentTrialExpired} />
          </Variant>
          <Variant
            label="Blocked: organization subscription ended"
            caption="Member sees an explanation, no action"
            roles="member"
          >
            <OrgProvisionPreflightPreview preflight={preflightFixtures.blockedParentSubEnded} />
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
            <OrgProvisionPreflightPreview preflight={preflightFixtures.blockedExistingInstance} />
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
          <Variant label="Payment failed" caption="Admin sees a Top up credits CTA" roles="admin">
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
          <Variant label="On the 30-day launch trial" caption="23 of 30 days left" roles="admin">
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
            caption="An owner turned KiloClaw off in organization settings"
            roles="admin"
          >
            <OrgSubscriptionPagePreview status={adminFixtures.blockedOptOut} />
          </Variant>

          <Variant label="Active" roles="member">
            <OrgSubscriptionPagePreview status={memberFixtures.available} />
          </Variant>
          <Variant label="On the 30-day launch trial" caption="23 of 30 days left" roles="member">
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
            <OrgDestroyConfirmDialogPreview isLaunchBackfill={true} currentPeriodEnd="2026-06-05" />
          </Variant>
        </Section>
      </PrototypePageShell>
    </RoleContext.Provider>
  );
}

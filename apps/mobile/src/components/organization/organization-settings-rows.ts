import {
  canManageOrganization,
  canManageOrganizationBilling,
  type OrganizationRole,
} from '@kilocode/app-shared/organizations';
import { type Href } from 'expo-router';

import {
  Building2,
  Cpu,
  FileText,
  KeyRound,
  LineChart,
  Lock,
  type LucideIcon,
  Plug,
  ScrollText,
  Server,
  Shield,
  SlidersHorizontal,
  Users,
  Wallet,
} from '@/components/ui/icons';
import { i18n } from '@/i18n';
import { type AppShellTarget } from '@/lib/app-shell-handoff';
import { providerKeysHref } from '@/lib/byok/provider-key-scope';
import { WEB_BASE_URL } from '@/lib/config';

/**
 * The organization destinations the hub lists, in the two shapes it opens
 * them: the web pages this app does not reimplement, and the areas the app
 * reads itself.
 *
 * Every web row opens the page that already owns the setting. The list, its
 * role and plan gates, and its destinations follow
 * `apps/web/src/app/(app)/components/OrganizationAppSidebar.tsx` plus the gate
 * each web page applies to itself, so a member never sees a row that would
 * bounce them off the page it opened:
 *
 * - the sidebar hides Model Access, Request logs, Invoices, Sub-organizations
 *   and BYOK from a role without billing authority
 *   (`canManageOrganizationBilling`);
 * - the sidebar hides Model Access and Groups below the enterprise plan;
 * - `sub-organizations` and `distribute-funds` additionally redirect for a
 *   child organization (`parent_organization_id !== null`);
 * - `guardrails` requires `owner`/`admin` and the organization's Kilo Encrypt
 *   setting;
 * - `providers-and-models`, `custom-modes`, `byok` and `integrations` render
 *   for every member;
 * - `data-collection` is the dashboard card a teams plan shows where an
 *   enterprise plan shows providers and models;
 * - `sso-and-domain` and `data-collection` are dashboard cards on the full web,
 *   but the app shell owns both, so those two rows hand off to shell pages
 *   instead of the full-web dashboard. Email preferences is a card with no
 *   shell page, so it has no row: the dashboard is a billing surface.
 *
 * Usage, the audit log and BYOK are the areas the app reads itself, so their
 * rows open the app's own screens instead of a page. Usage is visible to every
 * member, as on the web sidebar; the audit log's gate is the one its procedure
 * applies (billing role and the enterprise plan); BYOK opens the app's own
 * provider-keys screen with the organization's scope, behind the web sidebar's
 * billing-role gate.
 */
type OrgSettingsArea =
  | 'providersAndModels'
  | 'customModes'
  | 'groups'
  | 'guardrails'
  | 'ssoAndDomain'
  | 'dataCollection'
  | 'requestLogs'
  | 'integrations'
  | 'subOrganizations'
  | 'distributeFunds';

export type OrgSettingsGate = Readonly<{
  role: OrganizationRole | undefined;
  plan: 'teams' | 'enterprise';
  /** The organization has no parent: `parent_organization_id === null`. */
  isTopLevel: boolean;
  /** The organization's Kilo Encrypt setting, which decides whether guardrails exist. */
  guardrailsEnabled: boolean;
}>;

/** Where a row opens: a full-web page, or a shell page reached by hand-off. */
type OrgSettingsRowTarget =
  | Readonly<{ kind: 'web'; url: string }>
  | Readonly<{ kind: 'app-shell'; target: AppShellTarget }>;

export type OrgSettingsRow = Readonly<{
  area: OrgSettingsArea;
  title: string;
  icon: LucideIcon;
  /** The destination that owns the setting. */
  target: OrgSettingsRowTarget;
}>;

/**
 * The areas the app reads and writes itself, each opening its own screen
 * instead of a web page.
 */
type OrgInAppSettingsArea = 'usageDetails' | 'auditLogs' | 'byok';

export type OrgInAppSettingsRow = Readonly<{
  area: OrgInAppSettingsArea;
  title: string;
  icon: LucideIcon;
  /** The in-app screen that shows the area. */
  href: Href;
}>;

export type OrgInAppSettingsGate = Readonly<{
  role: OrganizationRole | undefined;
  plan: 'teams' | 'enterprise';
}>;

type OrgSettingsRowSpec = Readonly<{
  area: OrgSettingsArea;
  icon: LucideIcon;
  visible: (gate: OrgSettingsGate) => boolean;
}> &
  (
    | {
        /** The page's path after `/organizations/<id>`. */
        readonly suffix: string;
      }
    | {
        /**
         * The shell page that owns this card. The full web shows these two only
         * inside the app shell, so the row hands off to that page instead of a
         * full-web path.
         */
        readonly shellPage: 'organization-sso' | 'organization-data-collection';
      }
  );

const ROW_SPECS: readonly OrgSettingsRowSpec[] = [
  // "Model Access": billing role and the enterprise plan.
  {
    area: 'providersAndModels',
    icon: Cpu,
    suffix: '/providers-and-models',
    visible: gate => canManageOrganizationBilling(gate.role) && gate.plan === 'enterprise',
  },
  // "Custom Modes": no gate in the sidebar or on the page.
  { area: 'customModes', icon: SlidersHorizontal, suffix: '/custom-modes', visible: () => true },
  // "Groups": enterprise only; the page redirects every other plan.
  { area: 'groups', icon: Users, suffix: '/groups', visible: gate => gate.plan === 'enterprise' },
  // Guardrails page: owner/admin and Kilo Encrypt.
  {
    area: 'guardrails',
    icon: Shield,
    suffix: '/guardrails',
    visible: gate => canManageOrganization(gate.role) && gate.guardrailsEnabled,
  },
  // The SSO card renders only on an enterprise dashboard. It is a card rather
  // than a page of its own, and the app shell owns it, so the row opens the
  // shell page.
  {
    area: 'ssoAndDomain',
    icon: Lock,
    shellPage: 'organization-sso',
    visible: gate => gate.plan === 'enterprise',
  },
  // Data collection card: the teams dashboard shows it in place of providers
  // and models, and the app shell owns the card. Email preferences is a
  // dashboard card with no shell page, and the dashboard links to the seats
  // purchase, so the hub lists no row for it.
  {
    area: 'dataCollection',
    icon: Server,
    shellPage: 'organization-data-collection',
    visible: gate => gate.plan === 'teams',
  },
  // "Request Logs": billing role.
  {
    area: 'requestLogs',
    icon: FileText,
    suffix: '/request-logs',
    visible: gate => canManageOrganizationBilling(gate.role),
  },
  // "Integrations": no gate in the sidebar or on the page.
  { area: 'integrations', icon: Plug, suffix: '/integrations', visible: () => true },
  // "Sub-organizations": billing role and a top-level organization.
  {
    area: 'subOrganizations',
    icon: Building2,
    suffix: '/sub-organizations',
    visible: gate => canManageOrganizationBilling(gate.role) && gate.isTopLevel,
  },
  // Distribute funds is a sub-organizations section, so it carries that
  // section's gate rather than a page of its own.
  {
    area: 'distributeFunds',
    icon: Wallet,
    suffix: '/sub-organizations/distribute-funds',
    visible: gate => canManageOrganizationBilling(gate.role) && gate.isTopLevel,
  },
];

const TITLE_KEYS = {
  providersAndModels: 'organization.settingsOnWeb.providersAndModels',
  customModes: 'agentChat.modePicker.customModes',
  groups: 'organization.settingsOnWeb.groups',
  guardrails: 'organization.settingsOnWeb.guardrails',
  ssoAndDomain: 'organization.settingsOnWeb.ssoAndDomain',
  dataCollection: 'organization.settingsOnWeb.dataCollection',
  requestLogs: 'organization.settingsOnWeb.requestLogs',
  // The in-app organization Integrations row opens the app's own screen; this
  // one opens the web page, so it names the web instead of repeating that title.
  integrations: 'organization.settingsOnWeb.integrations',
  subOrganizations: 'organization.settingsOnWeb.subOrganizations',
  distributeFunds: 'organization.settingsOnWeb.distributeFunds',
} satisfies Record<OrgSettingsArea, string>;

/**
 * The audit log's gate. The sidebar lists the destination only for a billing
 * role on the enterprise plan, and the procedure behind it answers only a
 * billing role, so both the settings row and the screen's own guard read this.
 */
export function canViewOrgAuditLog(
  role: OrganizationRole | undefined,
  plan: 'teams' | 'enterprise'
): boolean {
  return canManageOrganizationBilling(role) && plan === 'enterprise';
}

type OrgInAppSettingsRowSpec = Readonly<{
  area: OrgInAppSettingsArea;
  icon: LucideIcon;
  /** The screen that owns the area, scoped to the organization it was opened for. */
  href: (organizationId: string) => Href;
  visible: (gate: OrgInAppSettingsGate) => boolean;
}>;

const IN_APP_ROW_SPECS: readonly OrgInAppSettingsRowSpec[] = [
  // "Usage": the app's own usage screen reads the same summary, series and
  // breakdown the web page charts, so the row opens the screen. Every member
  // sees it, as on the web sidebar, and nothing in its gate needs a payload.
  {
    area: 'usageDetails',
    icon: LineChart,
    href: () => '/(app)/(tabs)/(3_profile)/organization/usage',
    visible: () => true,
  },
  // "Audit logs": the gate its procedure applies, which the screen repeats to
  // itself. The row opens the screen rather than the web page.
  {
    area: 'auditLogs',
    icon: ScrollText,
    href: () => '/(app)/(tabs)/(3_profile)/organization/audit-log',
    visible: gate => canViewOrgAuditLog(gate.role, gate.plan),
  },
  // BYOK: the sidebar's billing-role gate, and the app's own provider-keys
  // screen with this organization's scope.
  {
    area: 'byok',
    icon: KeyRound,
    href: organizationId => providerKeysHref({ kind: 'organization', organizationId }),
    visible: gate => canManageOrganizationBilling(gate.role),
  },
];

const IN_APP_TITLE_KEYS = {
  // The copy's own name keeps its group prefix: the web sidebar lists the same
  // area under Dashboard, and check:i18n refuses a second key with this copy.
  usageDetails: 'organization.settingsOnWeb.usageDetails',
  auditLogs: 'organization.settingsOnWeb.auditLogs',
  byok: 'organization.settingsOnWeb.byok',
} satisfies Record<OrgInAppSettingsArea, string>;

/**
 * The rows this role and plan may open, in the order the section shows them.
 * A row whose gate fails is absent rather than disabled: the web page would
 * refuse it too, and a control that cannot work is not a control.
 */
export function visibleOrgSettingsRows(
  gate: OrgSettingsGate,
  organizationId: string
): readonly OrgSettingsRow[] {
  return ROW_SPECS.filter(spec => spec.visible(gate)).map((spec): OrgSettingsRow => ({
    area: spec.area,
    title: i18n.t(TITLE_KEYS[spec.area]),
    icon: spec.icon,
    target:
      'shellPage' in spec
        ? { kind: 'app-shell', target: { page: spec.shellPage, organizationId } }
        : { kind: 'web', url: `${WEB_BASE_URL}/organizations/${organizationId}${spec.suffix}` },
  }));
}

/**
 * The in-app rows this role and plan may open, in the order the card shows
 * them, each already carrying the organization it was opened for.
 *
 * The gate reads only the role and the plan, both of which arrive on the
 * organization row that decides whether the hub renders at all. So the hub
 * paints these rows on its first frame while the web rows below wait for the
 * membership payload: a row inserted above them later would move the group
 * under it, which the design gate's layout-shift rule refuses.
 */
export function visibleInAppSettingsRows(
  gate: OrgInAppSettingsGate,
  organizationId: string
): readonly OrgInAppSettingsRow[] {
  return IN_APP_ROW_SPECS.filter(spec => spec.visible(gate)).map(spec => ({
    area: spec.area,
    title: i18n.t(IN_APP_TITLE_KEYS[spec.area]),
    icon: spec.icon,
    href: spec.href(organizationId),
  }));
}

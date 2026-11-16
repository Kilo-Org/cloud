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
  Mail,
  Plug,
  ScrollText,
  Server,
  Shield,
  SlidersHorizontal,
  Users,
  Wallet,
} from '@/components/ui/icons';
import { i18n } from '@/i18n';
import { WEB_BASE_URL } from '@/lib/config';

/**
 * The organization destinations the hub lists, in the two shapes it opens
 * them: the web pages this app does not reimplement, and the areas the app
 * reads and writes itself.
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
 * - `providers-and-models`, `byok` and `integrations` render for every member;
 * - `data-collection` is the dashboard card a teams plan shows where an
 *   enterprise plan shows providers and models;
 * - `sso-and-domain`, `email-preferences` and `data-collection` are cards on
 *   the organization dashboard rather than pages of their own, so they open
 *   `/organizations/<id>`.
 *
 * The usage screen, the audit log, custom modes and groups are the exceptions
 * the two tables do not share: the app reads and writes them itself, so they are
 * in-app destinations. Each carries the gate its own procedure applies — usage
 * no gate at all, which is what every member sees on the web sidebar; the audit
 * log a billing role on the enterprise plan; groups the enterprise plan it is
 * sold with; and custom modes no gate, which is the gate its page has.
 */
type OrgSettingsArea =
  | 'providersAndModels'
  | 'guardrails'
  | 'byok'
  | 'ssoAndDomain'
  | 'emailPreferences'
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

export type OrgSettingsRow = Readonly<{
  area: OrgSettingsArea;
  title: string;
  icon: LucideIcon;
  /** The web page that owns the setting. */
  url: string;
}>;

/** The areas the app reads and writes itself instead of opening their web pages. */
type OrgInAppSettingsArea = 'customModes' | 'groups' | 'usageDetails' | 'auditLogs';

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
  /** The page's path after `/organizations/<id>`. Empty for a dashboard card. */
  suffix: string;
  visible: (gate: OrgSettingsGate) => boolean;
}>;

const ROW_SPECS: readonly OrgSettingsRowSpec[] = [
  // "Model Access": billing role and the enterprise plan.
  {
    area: 'providersAndModels',
    icon: Cpu,
    suffix: '/providers-and-models',
    visible: gate => canManageOrganizationBilling(gate.role) && gate.plan === 'enterprise',
  },
  // Guardrails page: owner/admin and Kilo Encrypt.
  {
    area: 'guardrails',
    icon: Shield,
    suffix: '/guardrails',
    visible: gate => canManageOrganization(gate.role) && gate.guardrailsEnabled,
  },
  // "Bring Your Own Key (BYOK)": billing role. The ChatGPT connection the
  // sidebar also counts is personal, so it does not make this row apply.
  {
    area: 'byok',
    icon: KeyRound,
    suffix: '/byok',
    visible: gate => canManageOrganizationBilling(gate.role),
  },
  // The SSO card renders only on an enterprise dashboard.
  {
    area: 'ssoAndDomain',
    icon: Lock,
    suffix: '',
    visible: gate => gate.plan === 'enterprise',
  },
  // Email preferences card: owner/admin.
  {
    area: 'emailPreferences',
    icon: Mail,
    suffix: '',
    visible: gate => canManageOrganization(gate.role),
  },
  // Data collection card: the teams dashboard shows it in place of providers
  // and models.
  { area: 'dataCollection', icon: Server, suffix: '', visible: gate => gate.plan === 'teams' },
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
  guardrails: 'organization.settingsOnWeb.guardrails',
  byok: 'organization.settingsOnWeb.byok',
  ssoAndDomain: 'organization.settingsOnWeb.ssoAndDomain',
  emailPreferences: 'organization.settingsOnWeb.emailPreferences',
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
  href: Href;
  visible: (gate: OrgInAppSettingsGate) => boolean;
}>;

const IN_APP_ROW_SPECS: readonly OrgInAppSettingsRowSpec[] = [
  // "Custom modes": no gate in the sidebar or on the page, so every member
  // reaches the native list and the server decides whether a write lands.
  {
    area: 'customModes',
    icon: SlidersHorizontal,
    href: '/(app)/(tabs)/(3_profile)/organization/modes',
    visible: () => true,
  },
  // "Groups": enterprise only, which is the plan its page redirects away from.
  {
    area: 'groups',
    icon: Users,
    href: '/(app)/(tabs)/(3_profile)/organization/groups',
    visible: gate => gate.plan === 'enterprise',
  },
  // "Usage": the app's own usage screen reads the same summary, series and
  // breakdown the web page charts, so the row opens the screen. Every member
  // sees it, as on the web sidebar, and nothing in its gate needs a payload.
  {
    area: 'usageDetails',
    icon: LineChart,
    href: '/(app)/(tabs)/(3_profile)/organization/usage',
    visible: () => true,
  },
  // "Audit logs": the gate its procedure applies, which the screen repeats to
  // itself. The row opens the screen rather than the web page.
  {
    area: 'auditLogs',
    icon: ScrollText,
    href: '/(app)/(tabs)/(3_profile)/organization/audit-log',
    visible: gate => canViewOrgAuditLog(gate.role, gate.plan),
  },
];

const IN_APP_TITLE_KEYS = {
  customModes: 'agentChat.modePicker.customModes',
  groups: 'organization.settingsOnWeb.groups',
  // The copy's own name keeps its group prefix: the web sidebar lists the same
  // area under Dashboard, and check:i18n refuses a second key with this copy.
  usageDetails: 'organization.settingsOnWeb.usageDetails',
  auditLogs: 'organization.settingsOnWeb.auditLogs',
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
  return ROW_SPECS.filter(spec => spec.visible(gate)).map(spec => ({
    area: spec.area,
    title: i18n.t(TITLE_KEYS[spec.area]),
    icon: spec.icon,
    url: `${WEB_BASE_URL}/organizations/${organizationId}${spec.suffix}`,
  }));
}

/**
 * The in-app rows this role and plan may open, in the order the card shows
 * them.
 *
 * The gate reads only the role and the plan, both of which arrive on the
 * organization row that decides whether the hub renders at all. So the hub
 * paints these rows on its first frame while the web rows below wait for the
 * membership payload: a row inserted above them later would move the group
 * under it, which the design gate's layout-shift rule refuses.
 */
export function visibleInAppSettingsRows(
  gate: OrgInAppSettingsGate
): readonly OrgInAppSettingsRow[] {
  return IN_APP_ROW_SPECS.filter(spec => spec.visible(gate)).map(spec => ({
    area: spec.area,
    title: i18n.t(IN_APP_TITLE_KEYS[spec.area]),
    icon: spec.icon,
    href: spec.href,
  }));
}

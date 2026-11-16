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
 * them: the screens this app reads itself, and the web pages it does not
 * reimplement.
 *
 * Every web row opens the page that already owns the setting. The list, its
 * role and plan gates, and its destinations follow
 * `apps/web/src/app/(app)/components/OrganizationAppSidebar.tsx` plus the gate
 * each web page applies to itself, so a member never sees a row that would
 * bounce them off the page it opened:
 *
 * - the sidebar hides Request logs, Invoices, Sub-organizations and BYOK from a
 *   role without billing authority (`canManageOrganizationBilling`);
 * - the sidebar hides Groups below the enterprise plan;
 * - `sub-organizations` and `distribute-funds` additionally redirect for a
 *   child organization (`parent_organization_id !== null`);
 * - `custom-modes`, `byok`, `integrations` and `usage-details` render for every
 *   member;
 * - `data-collection` is the dashboard card a teams plan shows;
 * - `sso-and-domain`, `email-preferences` and `data-collection` are cards on
 *   the organization dashboard rather than pages of their own, so they open
 *   `/organizations/<id>`.
 *
 * Three areas are in-app destinations instead, and each carries the gate its
 * own procedure applies: the audit log (billing role, enterprise plan), Model
 * Access (billing role, enterprise plan) and guardrails (`owner`/`admin` and
 * the organization's Kilo Encrypt setting).
 */
type OrgSettingsArea =
  | 'usageDetails'
  | 'customModes'
  | 'groups'
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
}>;

export type OrgSettingsRow = Readonly<{
  area: OrgSettingsArea;
  title: string;
  icon: LucideIcon;
  /** The web page that owns the setting. */
  url: string;
}>;

/**
 * The areas the app reads itself instead of opening their web pages. The
 * providers-and-models page and the guardrails page are the two settings the
 * organization hub opens natively; the audit log was the first.
 */
type OrgInAppSettingsArea = 'auditLogs' | 'providersAndModels' | 'guardrails';

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
  /**
   * The organization's Kilo Encrypt setting, which decides whether guardrails
   * exist. `undefined` while the membership payload is still on its way, so the
   * guardrails row waits for the same payload the web group below it waits for
   * instead of appearing a frame later and moving that group.
   */
  guardrailsEnabled: boolean | undefined;
}>;

type OrgSettingsRowSpec = Readonly<{
  area: OrgSettingsArea;
  icon: LucideIcon;
  /** The page's path after `/organizations/<id>`. Empty for a dashboard card. */
  suffix: string;
  visible: (gate: OrgSettingsGate) => boolean;
}>;

const ROW_SPECS: readonly OrgSettingsRowSpec[] = [
  // The sidebar lists Usage under Dashboard for every member.
  {
    area: 'usageDetails',
    icon: LineChart,
    suffix: '/usage-details?view=ai-usage',
    visible: () => true,
  },
  // "Custom Modes": no gate in the sidebar or on the page.
  { area: 'customModes', icon: SlidersHorizontal, suffix: '/custom-modes', visible: () => true },
  // "Groups": enterprise only; the page redirects every other plan.
  { area: 'groups', icon: Users, suffix: '/groups', visible: gate => gate.plan === 'enterprise' },
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
  usageDetails: 'organization.settingsOnWeb.usageDetails',
  customModes: 'agentChat.modePicker.customModes',
  groups: 'organization.settingsOnWeb.groups',
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
  // "Audit logs": the gate its procedure applies, which the screen repeats to
  // itself. The row opens the screen rather than the web page.
  {
    area: 'auditLogs',
    icon: ScrollText,
    href: '/(app)/(tabs)/(3_profile)/organization/audit-log',
    visible: gate => canViewOrgAuditLog(gate.role, gate.plan),
  },
  // "Model Access": the sidebar's own gate (billing role, enterprise plan),
  // which is also the plan the page itself refuses below.
  {
    area: 'providersAndModels',
    icon: Cpu,
    href: '/(app)/(tabs)/(3_profile)/organization/providers-and-models',
    visible: gate => canManageOrganizationBilling(gate.role) && gate.plan === 'enterprise',
  },
  // Guardrails: owner/admin and the organization's Kilo Encrypt setting, which
  // the guardrails procedure itself enforces.
  {
    area: 'guardrails',
    icon: Shield,
    href: '/(app)/(tabs)/(3_profile)/organization/guardrails',
    visible: gate => canManageOrganization(gate.role) && gate.guardrailsEnabled === true,
  },
];

const IN_APP_TITLE_KEYS = {
  auditLogs: 'organization.settingsOnWeb.auditLogs',
  providersAndModels: 'organization.settingsOnWeb.providersAndModels',
  guardrails: 'organization.settingsOnWeb.guardrails',
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

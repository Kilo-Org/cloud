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
  type LucideIcon,
  Plug,
  ScrollText,
  Shield,
  SlidersHorizontal,
  Users,
  Wallet,
} from '@/components/ui/icons';
import { i18n } from '@/i18n';
import { providerKeysHref } from '@/lib/byok/provider-key-scope';
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
 * - `custom-modes`, `byok` and `integrations` render for every member;
 * - `sso-and-domain`, `email-preferences` and `data-collection` are cards on
 *   the organization dashboard rather than pages of their own, and the
 *   dashboard links to the seats purchase, so the hub lists none of them.
 *
 * Five areas are in-app destinations instead, and each carries the gate its
 * own procedure applies: usage (every member), the audit log (billing role,
 * enterprise plan), Model Access (billing role, enterprise plan), guardrails
 * (`owner`/`admin` and the organization's Kilo Encrypt setting) and BYOK (the
 * billing role, opening the app's own provider-keys screen with the
 * organization's scope).
 */
type OrgSettingsArea =
  | 'customModes'
  | 'groups'
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

type OrgInAppSettingsArea =
  | 'usageDetails'
  | 'auditLogs'
  | 'providersAndModels'
  | 'guardrails'
  | 'byok';

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
  /** The page's path after `/organizations/<id>`. */
  suffix: string;
  visible: (gate: OrgSettingsGate) => boolean;
}>;

const ROW_SPECS: readonly OrgSettingsRowSpec[] = [
  // "Custom Modes": no gate in the sidebar or on the page.
  { area: 'customModes', icon: SlidersHorizontal, suffix: '/custom-modes', visible: () => true },
  // "Groups": enterprise only; the page redirects every other plan.
  { area: 'groups', icon: Users, suffix: '/groups', visible: gate => gate.plan === 'enterprise' },
  // The SSO card, the email preferences card and the data collection card live
  // on the organization dashboard itself, and that page links to the seats
  // purchase. The hub does not list a row that lands there: no suffix means a
  // dashboard card, and the dashboard is never a settings destination here.
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
  customModes: 'agentChat.modePicker.customModes',
  groups: 'organization.settingsOnWeb.groups',
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
  providersAndModels: 'organization.settingsOnWeb.providersAndModels',
  guardrails: 'organization.settingsOnWeb.guardrails',
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
  return ROW_SPECS.filter(spec => spec.visible(gate)).map(spec => ({
    area: spec.area,
    title: i18n.t(TITLE_KEYS[spec.area]),
    icon: spec.icon,
    url: `${WEB_BASE_URL}/organizations/${organizationId}${spec.suffix}`,
  }));
}

/**
 * The in-app rows this role and plan may open, in the order the card shows
 * them, each already carrying the organization it was opened for.
 *
 * The role and the plan arrive on the organization row that decides whether the
 * hub renders at all, so usage, the audit log and Model Access paint on the
 * hub's first frame. Guardrails also reads the organization's Kilo Encrypt
 * setting, so it lands with the membership payload — the same commit that
 * paints the web rows below it, so nothing already on screen moves.
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

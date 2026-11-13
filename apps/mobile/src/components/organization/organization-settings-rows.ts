import {
  canManageOrganization,
  canManageOrganizationBilling,
  type OrganizationRole,
} from '@kilocode/app-shared/organizations';

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
 * The organization destinations this app does not reimplement. Each row opens
 * the page that already owns the setting on the web.
 *
 * The list, its role and plan gates, and its destinations follow
 * `apps/web/src/app/(app)/components/OrganizationAppSidebar.tsx` plus the gate
 * each web page applies to itself, so a member never sees a row that would
 * bounce them off the page it opened:
 *
 * - the sidebar hides Model Access, Audit logs, Request logs, Invoices,
 *   Sub-organizations and BYOK from a role without billing authority
 *   (`canManageOrganizationBilling`);
 * - the sidebar hides Model Access, Groups and Audit logs below the enterprise
 *   plan;
 * - `sub-organizations` and `distribute-funds` additionally redirect for a
 *   child organization (`parent_organization_id !== null`);
 * - `audit-logs` renders for a member, but its procedure answers only a
 *   billing role, so the row keeps the billing gate;
 * - `guardrails` requires `owner`/`admin` and the organization's Kilo Encrypt
 *   setting;
 * - `providers-and-models`, `custom-modes`, `byok`, `integrations` and
 *   `usage-details` render for every member;
 * - `data-collection` is the dashboard card a teams plan shows where an
 *   enterprise plan shows providers and models;
 * - `sso-and-domain`, `email-preferences` and `data-collection` are cards on
 *   the organization dashboard rather than pages of their own, so they open
 *   `/organizations/<id>`.
 */
type OrgSettingsArea =
  | 'usageDetails'
  | 'providersAndModels'
  | 'customModes'
  | 'groups'
  | 'guardrails'
  | 'byok'
  | 'ssoAndDomain'
  | 'emailPreferences'
  | 'dataCollection'
  | 'auditLogs'
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
  /**
   * Whether the row opens the web page. `false` opens the in-app screen, which
   * only the audit log has: every other area is edited nowhere but the web.
   */
  web: boolean;
}>;

type OrgSettingsRowSpec = Readonly<{
  area: OrgSettingsArea;
  icon: LucideIcon;
  /** The page's path after `/organizations/<id>`. Empty for a dashboard card. */
  suffix: string;
  visible: (gate: OrgSettingsGate) => boolean;
  /** `false` for the area this app reads natively. */
  web?: boolean;
}>;

const ROW_SPECS: readonly OrgSettingsRowSpec[] = [
  // The sidebar lists Usage under Dashboard for every member.
  {
    area: 'usageDetails',
    icon: LineChart,
    suffix: '/usage-details?view=ai-usage',
    visible: () => true,
  },
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
  // "Audit Logs": billing role and the enterprise plan. This one area is read
  // in the app, so the row opens the native screen instead of the web page.
  {
    area: 'auditLogs',
    icon: ScrollText,
    suffix: '/audit-logs',
    visible: gate => canViewOrgAuditLog(gate.role, gate.plan),
    web: false,
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
  usageDetails: 'organization.settingsOnWeb.usageDetails',
  providersAndModels: 'organization.settingsOnWeb.providersAndModels',
  customModes: 'agentChat.modePicker.customModes',
  groups: 'organization.settingsOnWeb.groups',
  guardrails: 'organization.settingsOnWeb.guardrails',
  byok: 'organization.settingsOnWeb.byok',
  ssoAndDomain: 'organization.settingsOnWeb.ssoAndDomain',
  emailPreferences: 'organization.settingsOnWeb.emailPreferences',
  dataCollection: 'organization.settingsOnWeb.dataCollection',
  auditLogs: 'organization.settingsOnWeb.auditLogs',
  requestLogs: 'organization.settingsOnWeb.requestLogs',
  integrations: 'integrations.title',
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
    web: spec.web !== false,
  }));
}

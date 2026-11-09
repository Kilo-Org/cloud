import {
  findSupportAllowEntry,
  supportAccessDenialAction,
  type SupportAccessDenialAction,
  type SupportAccessReason,
} from '@kilocode/web-shared/lib/admin/support-access';

export type SupportAccessNeededContent = {
  description: string;
  action: SupportAccessDenialAction;
  canRequest: boolean;
  dashboardHref: string | null;
  adminHref: string;
};

export function supportAccessNeededContent(params: {
  organizationId: string;
  organizationName: string | null;
  reason: SupportAccessReason | null;
  dashboardIsCurrent?: boolean;
}): SupportAccessNeededContent {
  const organizationName = params.organizationName ?? 'this organization';
  const action = supportAccessDenialAction(params.reason);
  const dashboardSlug = '/organizations/[id]';
  const dashboardAllowlisted =
    findSupportAllowEntry({
      surface: 'server-component',
      key: dashboardSlug,
      actionClass: 'support_read',
    }) !== undefined;
  return {
    description: descriptionFor(action, params.reason, organizationName),
    action,
    canRequest: action === 'request',
    dashboardHref:
      dashboardAllowlisted && params.dashboardIsCurrent !== true
        ? `/organizations/${params.organizationId}`
        : null,
    adminHref: `/admin/organizations/${params.organizationId}`,
  };
}

function descriptionFor(
  action: SupportAccessDenialAction,
  reason: SupportAccessReason | null,
  organizationName: string
): string {
  if (action === 'retry' || reason === null) {
    return 'Support access could not be verified. Refresh the page to try again.';
  }
  if (action === 'request') {
    switch (reason) {
      case 'support_grant_expired':
        return `Your support access to ${organizationName} expired. Request read access to continue.`;
      case 'support_grant_revoked':
        return `Your support access to ${organizationName} was revoked. Request read access to continue.`;
      default:
        return `You need support access to view ${organizationName}. Request read access to continue.`;
    }
  }
  return "This page isn't available through support access. Open the organization dashboard or the admin organization page instead.";
}

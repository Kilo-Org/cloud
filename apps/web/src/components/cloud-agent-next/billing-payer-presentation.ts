import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import type { CustomerBillingFailure } from '@kilocode/cloud-agent-sdk';

export type BillingPayerPresentation = {
  payerName: string;
  action?: { href: string; label: string; memberGuidance?: boolean };
};

export function billingPayerPresentation(
  failure: CustomerBillingFailure,
  surface: {
    currentUserId?: string;
    organization?: { id: string; name: string; role: OrganizationRole };
  }
): BillingPayerPresentation {
  const canRecoverWithCredits = failure.code === 'INSUFFICIENT_CREDITS';
  if (
    failure.payer.type === 'user' &&
    !surface.organization &&
    failure.payer.id === surface.currentUserId
  ) {
    return {
      payerName: 'Your account',
      ...(canRecoverWithCredits ? { action: { href: '/credits', label: 'Add credits' } } : {}),
    };
  }
  const organization = surface.organization;
  if (!organization || failure.payer.type !== 'org' || failure.payer.id !== organization.id) {
    return { payerName: failure.payer.type === 'org' ? 'This organization' : 'Your account' };
  }
  return {
    payerName: organization.name,
    ...(canRecoverWithCredits
      ? {
          action: canManageOrganizationBilling(organization.role)
            ? { href: `/organizations/${organization.id}`, label: 'Add organization credits' }
            : {
                href: `/organizations/${organization.id}/payment-details`,
                label: 'View organization billing',
                memberGuidance: true,
              },
        }
      : {}),
  };
}

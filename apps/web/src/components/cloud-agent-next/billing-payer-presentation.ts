import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import type { CustomerBillingFailure } from '@kilocode/cloud-agent-sdk';

export type BillingPayerPresentation = {
  payerName: string;
  action?: { href: string; label: string };
  /** The viewer cannot pay for this organization; the banner names who can. */
  memberGuidance?: boolean;
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
  if (!canRecoverWithCredits) {
    return { payerName: organization.name };
  }
  // Billing surfaces are gated on the organization billing roles, so a plain member gets no
  // navigation target: the banner names the roles that can add credits instead.
  if (!canManageOrganizationBilling(organization.role)) {
    return { payerName: organization.name, memberGuidance: true };
  }
  return {
    payerName: organization.name,
    action: { href: `/organizations/${organization.id}`, label: 'Add organization credits' },
  };
}

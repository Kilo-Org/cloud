import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { TRPCError } from '@trpc/server';
import { isKiloEncryptEnabled } from './kilo-encrypt';

export async function requireGuardrailsOrganization(organizationId: string) {
  const organization = await getOrganizationById(organizationId);
  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
  if (!isKiloEncryptEnabled(organization.settings)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'AI Guardrails is not available for this organization.',
    });
  }
  return organization;
}

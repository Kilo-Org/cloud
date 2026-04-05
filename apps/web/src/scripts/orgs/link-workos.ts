import { WORKOS_API_KEY } from '@/lib/config.server';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { WorkOS } from '@workos-inc/node';
const workos = new WorkOS(WORKOS_API_KEY);

export async function run(organizationId: string, workosOrgId: string) {
  if (!organizationId || !workosOrgId) {
    console.error(
      'Usage: pnpm script src/scripts/orgs/link-workos.ts <organization_id> <workos_org_id>'
    );
    process.exit(1);
  }
  console.log(
    'Linking WorkOS organization:',
    workosOrgId,
    'to local organization:',
    organizationId
  );
  const org = await getOrganizationById(organizationId);
  if (!org) {
    console.error('Organization not found:', organizationId);
    process.exit(1);
  }
  await workos.organizations.updateOrganization({
    organization: workosOrgId,
    externalId: organizationId,
  });
  console.log('Successfully linked WorkOS organization to local organization');
  process.exit(0);
}

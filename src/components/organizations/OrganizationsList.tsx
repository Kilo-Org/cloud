import type { OrganizationCardOrg } from './OrganizationCard';
import { OrganizationCard } from './OrganizationCard';
import { NewOrganizationCard } from './NewOrganizationCard';

type IncompleteOrganization = {
  id: string;
  name: string;
  created_at: string;
};

type OrganizationsListProps = {
  orgs: OrganizationCardOrg[];
  incompleteOrgs?: IncompleteOrganization[];
};

export function OrganizationsList({ orgs }: OrganizationsListProps) {
  return (
    <div className="grid gap-4">
      {orgs.length > 0 && orgs.map(org => <OrganizationCard key={org.organizationId} org={org} />)}
      {<NewOrganizationCard />}
    </div>
  );
}

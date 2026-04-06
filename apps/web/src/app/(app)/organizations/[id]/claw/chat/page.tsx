import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgClawChatClient } from './OrgClawChatClient';

type OrgClawChatPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrgClawChatPage({ params }: OrgClawChatPageProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={org => <OrgClawChatClient organizationId={org.organization.id} />}
    />
  );
}

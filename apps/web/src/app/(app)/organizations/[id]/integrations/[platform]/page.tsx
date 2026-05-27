import {
  OrganizationIntegrationDetailPage,
  type IntegrationDetailSearchParams,
} from '@/components/integrations/IntegrationDetailPage';

export default async function OrganizationPlatformIntegrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; platform: string }>;
  searchParams: IntegrationDetailSearchParams;
}) {
  const { platform } = await params;

  return (
    <OrganizationIntegrationDetailPage
      params={params}
      platform={platform}
      searchParams={searchParams}
    />
  );
}

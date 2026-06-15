import {
  UserIntegrationDetailPage,
  type IntegrationDetailSearchParams,
} from '@/components/integrations/IntegrationDetailPage';

export default async function UserPlatformIntegrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ platform: string }>;
  searchParams: IntegrationDetailSearchParams;
}) {
  const { platform } = await params;

  return <UserIntegrationDetailPage platform={platform} searchParams={searchParams} />;
}

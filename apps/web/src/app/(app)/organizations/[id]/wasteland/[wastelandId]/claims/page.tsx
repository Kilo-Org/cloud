import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { ClaimsClient } from '@/app/(app)/wasteland/[wastelandId]/claims/ClaimsClient';

export default async function OrgClaimsPage({
  params,
}: {
  params: Promise<{ id: string; wastelandId: string }>;
}) {
  const { wastelandId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <ClaimsClient wastelandId={wastelandId} />}
    />
  );
}

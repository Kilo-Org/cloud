import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { MembersClient } from '@/app/(app)/wasteland/[wastelandId]/members/MembersClient';

export default async function OrgMembersPage({
  params,
}: {
  params: Promise<{ id: string; wastelandId: string }>;
}) {
  const { wastelandId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <MembersClient wastelandId={wastelandId} />}
    />
  );
}

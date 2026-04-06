import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { WantedBoardClient } from '@/app/(app)/wasteland/[wastelandId]/wanted/WantedBoardClient';

export default async function OrgWantedBoardPage({
  params,
}: {
  params: Promise<{ id: string; wastelandId: string }>;
}) {
  const { wastelandId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <WantedBoardClient wastelandId={wastelandId} />}
    />
  );
}

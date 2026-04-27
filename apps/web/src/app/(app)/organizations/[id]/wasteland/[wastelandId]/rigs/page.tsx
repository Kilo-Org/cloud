import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { RigsClient } from '@/app/(app)/wasteland/[wastelandId]/rigs/RigsClient';

export default async function OrgRigsPage({
  params,
}: {
  params: Promise<{ id: string; wastelandId: string }>;
}) {
  const { wastelandId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <RigsClient wastelandId={wastelandId} />}
    />
  );
}

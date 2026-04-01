import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { SettingsClient } from '@/app/(app)/wasteland/[wastelandId]/settings/SettingsClient';

export default async function OrgSettingsPage({
  params,
}: {
  params: Promise<{ id: string; wastelandId: string }>;
}) {
  const { wastelandId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <SettingsClient wastelandId={wastelandId} />}
    />
  );
}

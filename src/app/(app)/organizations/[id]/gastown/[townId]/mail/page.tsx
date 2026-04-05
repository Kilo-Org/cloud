import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { MailPageClient } from '@/app/(app)/gastown/[townId]/mail/MailPageClient';

export default async function OrgMailPage({
  params,
}: {
  params: Promise<{ id: string; townId: string }>;
}) {
  const { townId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <MailPageClient townId={townId} />}
    />
  );
}

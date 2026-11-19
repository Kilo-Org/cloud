'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CopyTextButton } from '@/components/admin/CopyEmailButton';
import { AnthropicUserProfileStatus } from '@/components/admin/AnthropicUserProfileStatus';
import { useAdminOrganizationDetails } from '@/app/admin/api/organizations/hooks';
import { useTRPC } from '@/lib/trpc/utils';

export function OrganizationAdminAnthropicUserProfile({
  organizationId,
}: {
  organizationId: string;
}) {
  const trpc = useTRPC();
  const { data } = useAdminOrganizationDetails(organizationId);
  const status = useQuery(
    trpc.organizations.admin.pullAnthropicUserProfileStatus.queryOptions(
      { organizationId },
      { enabled: false, retry: false }
    )
  );
  const profileId = data?.anthropic_user_profile_id;
  if (!profileId) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Anthropic user profile</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-1">
          <span className="font-mono text-sm break-all">{profileId}</span>
          <CopyTextButton text={profileId} />
        </div>
        <AnthropicUserProfileStatus query={status} />
      </CardContent>
    </Card>
  );
}

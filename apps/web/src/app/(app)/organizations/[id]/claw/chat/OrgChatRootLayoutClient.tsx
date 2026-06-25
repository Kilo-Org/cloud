'use client';

import { useUser } from '@/hooks/useUser';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';
import { KiloChatLayout } from '@/app/(app)/claw/kilo-chat/components/KiloChatLayout';

export function OrgChatRootLayoutClient({
  children,
  organizationId,
  organizationRouteIdentifier,
}: {
  children: React.ReactNode;
  organizationId: string;
  organizationRouteIdentifier: string;
}) {
  const { data: user } = useUser();
  const { data: status, error, isError, isLoading, refetch } = useOrgKiloClawStatus(organizationId);
  const instanceErrorMessage =
    error instanceof Error ? error.message : error ? 'Unknown error' : null;

  return (
    <KiloChatLayout
      currentUserId={user?.id ?? null}
      sandboxId={status?.sandboxId ?? null}
      basePath={`/organizations/${organizationRouteIdentifier}/claw/chat`}
      noInstanceRedirect={`/organizations/${organizationRouteIdentifier}/claw/new`}
      instanceStatus={status?.status ?? null}
      isInstanceLoading={isLoading}
      isInstanceError={isError}
      instanceErrorMessage={instanceErrorMessage}
      onRetryInstanceStatus={() => void refetch()}
      assistantName={status?.botName ?? null}
      assistantEmoji={status?.botEmoji ?? null}
    >
      {children}
    </KiloChatLayout>
  );
}

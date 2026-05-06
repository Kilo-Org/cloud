'use client';

import { useParams } from 'next/navigation';
import { useUser } from '@/hooks/useUser';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';
import { KiloChatLayout } from '@/app/(app)/claw/kilo-chat/components/KiloChatLayout';

export default function OrgKiloChatRootLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const organizationId = params.id;
  const { data: user } = useUser();
  const { data: status, error, isError, isLoading, refetch } = useOrgKiloClawStatus(organizationId);
  const instanceErrorMessage =
    error instanceof Error ? error.message : error ? 'Unknown error' : null;

  const basePath = `/organizations/${organizationId}/claw/kilo-chat`;
  const noInstanceRedirect = `/organizations/${organizationId}/claw/new`;

  return (
    <KiloChatLayout
      currentUserId={user?.id ?? null}
      sandboxId={status?.sandboxId ?? null}
      basePath={basePath}
      noInstanceRedirect={noInstanceRedirect}
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

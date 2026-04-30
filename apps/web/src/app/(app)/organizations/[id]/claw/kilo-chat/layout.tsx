'use client';

import { useParams } from 'next/navigation';
import { useUser } from '@/hooks/useUser';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';
import { KiloChatLayout } from '@/app/(app)/claw/kilo-chat/components/KiloChatLayout';
import { currentUserIdFromUser } from '@/app/(app)/claw/kilo-chat/components/current-user-state';

export default function OrgKiloChatRootLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const organizationId = params.id;
  const { data: user } = useUser();
  const { data: status, isLoading } = useOrgKiloClawStatus(organizationId);

  const basePath = `/organizations/${organizationId}/claw/kilo-chat`;
  const noInstanceRedirect = `/organizations/${organizationId}/claw/new`;

  return (
    <KiloChatLayout
      currentUserId={currentUserIdFromUser(user)}
      sandboxId={status?.sandboxId ?? null}
      basePath={basePath}
      noInstanceRedirect={noInstanceRedirect}
      instanceStatus={status?.status ?? null}
      isInstanceLoading={isLoading}
      assistantName={status?.botName ?? null}
    >
      {children}
    </KiloChatLayout>
  );
}

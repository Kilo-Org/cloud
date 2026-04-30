'use client';

import { useUser } from '@/hooks/useUser';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { KiloChatLayout } from './components/KiloChatLayout';
import { currentUserIdFromUser } from './components/current-user-state';

export default function KiloChatRootLayout({ children }: { children: React.ReactNode }) {
  const { data: user } = useUser();
  const { data: status, isLoading } = useKiloClawStatus();

  return (
    <KiloChatLayout
      currentUserId={currentUserIdFromUser(user)}
      sandboxId={status?.sandboxId ?? null}
      basePath="/claw/kilo-chat"
      noInstanceRedirect="/claw/new"
      instanceStatus={status?.status ?? null}
      isInstanceLoading={isLoading}
      assistantName={status?.botName ?? null}
    >
      {children}
    </KiloChatLayout>
  );
}

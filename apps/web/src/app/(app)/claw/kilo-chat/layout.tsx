'use client';

import { useCallback } from 'react';
import { useUser } from '@/hooks/useUser';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { getKiloChatToken } from './token';
import { KiloChatLayout } from './components/KiloChatLayout';

export default function KiloChatRootLayout({ children }: { children: React.ReactNode }) {
  const { data: user } = useUser();
  const { data: status, isLoading } = useKiloClawStatus();

  const getToken = useCallback(() => getKiloChatToken(), []);

  return (
    <KiloChatLayout
      getToken={getToken}
      currentUserId={user?.id ?? ''}
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

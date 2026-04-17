'use client';

import { useCallback } from 'react';
import { useUser } from '@/hooks/useUser';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { getKiloChatToken } from './token';
import { KiloChatLayout } from './components/KiloChatLayout';

export default function KiloChatRootLayout({ children }: { children: React.ReactNode }) {
  const { data: user } = useUser();
  const { data: status } = useKiloClawStatus();

  // Stable reference so KiloChatLayout and hooks receive the same function identity.
  const getToken = useCallback(() => getKiloChatToken(), []);

  // Derive instance list from the single personal instance the status hook exposes.
  // When multi-instance support is added, this can be expanded.
  const instances = status?.sandboxId
    ? [{ sandboxId: status.sandboxId, label: status.name ?? 'My Instance' }]
    : [];

  const currentUserId = user?.id ?? '';

  return (
    <KiloChatLayout
      getToken={getToken}
      currentUserId={currentUserId}
      instances={instances}
      instanceStatus={status?.status ?? null}
      assistantName={status?.botName ?? null}
    >
      {children}
    </KiloChatLayout>
  );
}

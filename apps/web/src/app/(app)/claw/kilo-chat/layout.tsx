'use client';

import { useEffect, useState, useCallback } from 'react';
import { useUser } from '@/hooks/useUser';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { getKiloChatToken } from './token';
import { KiloChatLayout } from './components/KiloChatLayout';

export default function KiloChatRootLayout({ children }: { children: React.ReactNode }) {
  const { data: user } = useUser();
  const { data: status } = useKiloClawStatus();
  const [token, setToken] = useState<string | null>(null);

  // Stable reference so KiloChatLayout and hooks receive the same function identity.
  const getToken = useCallback(() => getKiloChatToken(), []);

  // Eagerly fetch the token so SSE can start without an extra round-trip.
  useEffect(() => {
    let cancelled = false;
    getKiloChatToken()
      .then(t => {
        if (!cancelled) setToken(t);
      })
      .catch(() => {
        // Token fetch failed; SSE will be skipped until token becomes available.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      token={token}
      instances={instances}
    >
      {children}
    </KiloChatLayout>
  );
}

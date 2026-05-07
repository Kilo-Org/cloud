'use client';

import { useUser } from '@/hooks/useUser';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { KiloChatLayout } from './components/KiloChatLayout';

export default function KiloChatRootLayout({ children }: { children: React.ReactNode }) {
  const { data: user } = useUser();
  const { data: status, error, isError, isLoading, refetch } = useKiloClawStatus();
  const instanceErrorMessage =
    error instanceof Error ? error.message : error ? 'Unknown error' : null;

  return (
    <KiloChatLayout
      currentUserId={user?.id ?? null}
      sandboxId={status?.sandboxId ?? null}
      basePath="/claw/kilo-chat"
      noInstanceRedirect="/claw/new"
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

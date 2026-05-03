'use client';

import { useUser } from '@/hooks/useUser';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { KiloChatLayout } from '@/app/(app)/claw/kilo-chat/components/KiloChatLayout';

export default function ChatRootLayout({ children }: { children: React.ReactNode }) {
  const { data: user } = useUser();
  const { data: status, error, isError, isLoading, refetch } = useKiloClawStatus();
  const instanceErrorMessage =
    error instanceof Error ? error.message : error ? 'Unknown error' : null;

  return (
    <KiloChatLayout
      currentUserId={user?.id ?? null}
      sandboxId={status?.sandboxId ?? null}
      basePath="/claw/chat"
      noInstanceRedirect="/claw/new"
      instanceStatus={status?.status ?? null}
      isInstanceLoading={isLoading}
      isInstanceError={isError}
      instanceErrorMessage={instanceErrorMessage}
      onRetryInstanceStatus={() => void refetch()}
      assistantName={status?.botName ?? null}
    >
      {children}
    </KiloChatLayout>
  );
}

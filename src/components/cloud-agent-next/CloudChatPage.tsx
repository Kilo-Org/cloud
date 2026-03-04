/**
 * Cloud Chat Page
 *
 * Owns the sidebar session query so it runs outside CloudChatContainer,
 * whose frequent internal state changes would otherwise cause redundant
 * unifiedSessions.list invocations batched by tRPC.
 */

'use client';

import { CloudChatContainer } from './CloudChatContainer';
import { useSidebarSessions } from './hooks/useSidebarSessions';

type CloudChatPageProps = {
  organizationId?: string;
};

export default function CloudChatPage({ organizationId }: CloudChatPageProps) {
  const { sessions, refetchSessions } = useSidebarSessions({
    organizationId: organizationId ?? null,
  });
  return (
    <CloudChatContainer
      organizationId={organizationId}
      sessions={sessions}
      refetchSessions={refetchSessions}
    />
  );
}

// Named export for compatibility
export { CloudChatPage };

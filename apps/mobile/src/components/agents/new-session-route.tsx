import { NewSessionModelProvider } from '@/components/agents/new-session-model-provider';
import { NewSessionScreenBody } from '@/components/agents/new-session-screen-body';

/**
 * The New-session composer with the caller's organization context. Rendered by
 * the `agent-chat/new` route and by the session-detail route when its
 * `session-id` param cannot be a session id.
 */
export function NewSessionRoute({ organizationId }: { organizationId?: string }) {
  return (
    <NewSessionModelProvider organizationId={organizationId}>
      <NewSessionScreenBody />
    </NewSessionModelProvider>
  );
}

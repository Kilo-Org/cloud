import { type AgentSessionRouterLike } from '@/components/agents/session-router-like';

type ExitRemoteCliWithFeedbackInput = {
  exit: () => Promise<void>;
  onAccepted: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
  router: AgentSessionRouterLike;
};

const SESSIONS_ROUTE = '/(app)/(tabs)/(2_agents)' as const;

export async function exitRemoteCliWithFeedback({
  exit,
  onAccepted,
  onSuccess,
  onError,
  router,
}: Readonly<ExitRemoteCliWithFeedbackInput>): Promise<void> {
  try {
    await exit();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to exit CLI';
    onError(message);
    throw error;
  }

  onAccepted();
  onSuccess('CLI exited');
  router.replace(SESSIONS_ROUTE);
}

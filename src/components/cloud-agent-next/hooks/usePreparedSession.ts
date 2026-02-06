import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import {
  linkCloudAgentSessionAtom,
  updateCloudAgentSessionIdAtom,
} from '../store/db-session-atoms';
import type { AgentMode } from '../types';

export type PrepareSessionConfig = {
  prompt: string;
  mode: AgentMode;
  model: string;
  githubRepo?: string;
  gitlabProject?: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
  autoCommit?: boolean;
  profileName?: string;
};

export type UsePreparedSessionOptions = {
  organizationId?: string;
  kiloSessionId?: string;
};

export function usePreparedSession(options: UsePreparedSessionOptions = {}) {
  const trpcClient = useRawTRPCClient();
  const updateCloudAgentSessionIdAction = useSetAtom(updateCloudAgentSessionIdAtom);
  const linkCloudAgentSession = useSetAtom(linkCloudAgentSessionAtom);
  const { organizationId, kiloSessionId } = options;

  const prepareSession = useCallback(
    async (config: PrepareSessionConfig): Promise<string> => {
      // Use cloudAgentNext endpoints with new modes ('plan' | 'build')
      const result = organizationId
        ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
            ...config,
            organizationId,
          })
        : await trpcClient.cloudAgentNext.prepareSession.mutate(config);

      if (kiloSessionId) {
        await updateCloudAgentSessionIdAction({
          sessionId: kiloSessionId,
          cloudAgentSessionId: result.cloudAgentSessionId,
        });
      }
      linkCloudAgentSession(result.cloudAgentSessionId);

      return result.cloudAgentSessionId;
    },
    [
      trpcClient,
      updateCloudAgentSessionIdAction,
      linkCloudAgentSession,
      organizationId,
      kiloSessionId,
    ]
  );

  return { prepareSession };
}

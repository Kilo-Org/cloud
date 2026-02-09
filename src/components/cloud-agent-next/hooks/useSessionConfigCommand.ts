import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { toast } from 'sonner';
import {
  updateResumeConfigAtom,
  extractRepoFromGitUrl,
  type DbSessionDetails,
  type StoredResumeConfig,
} from '../store/db-session-atoms';
import { sessionConfigAtom } from '../store/atoms';
import { buildSessionConfig } from '../session-config';
import type { ResumeConfig } from '../ResumeConfigModal';

/**
 * Command hook for applying resume configuration.
 * Handles persistence and state updates in one place.
 *
 * Separates concerns:
 * - Modal UI state: handled by useResumeConfigModal
 * - Persistence + state updates: handled here
 * - Orchestration: handled by CloudChatPage via effects
 */
export function useSessionConfigCommand() {
  const updateResumeConfig = useSetAtom(updateResumeConfigAtom);
  const setSessionConfig = useSetAtom(sessionConfigAtom);

  /**
   * Apply a resume configuration to a session.
   * This command:
   * 1. Persists config to IndexedDB
   * 2. Updates application state (sessionConfigAtom)
   * 3. Notifies user of success
   *
   * @throws Error if persistence fails
   */
  const applyResumeConfig = useCallback(
    async (params: {
      config: ResumeConfig;
      sessionId: string;
      loadedDbSession: DbSessionDetails;
    }) => {
      const { config, sessionId, loadedDbSession } = params;

      try {
        // 1. Persist to IndexedDB
        const storedConfig: StoredResumeConfig = {
          mode: config.mode,
          model: config.model,
          envVars: config.envVars,
          setupCommands: config.setupCommands,
        };

        await updateResumeConfig({
          sessionId,
          resumeConfig: storedConfig,
        });

        // 2. Update application state
        const repository = extractRepoFromGitUrl(loadedDbSession.git_url);
        setSessionConfig(
          buildSessionConfig({
            sessionId: loadedDbSession.cloud_agent_session_id || loadedDbSession.session_id,
            repository: repository || '',
            resumeConfig: {
              mode: config.mode,
              model: config.model,
            },
          })
        );

        // 3. Notify user
        toast.success('Session configured. Send a message to start the cloud agent.');
      } catch (error) {
        console.error('Failed to apply resume config:', error);
        toast.error('Failed to save configuration. Please try again.');
        throw error;
      }
    },
    [updateResumeConfig, setSessionConfig]
  );

  return { applyResumeConfig };
}

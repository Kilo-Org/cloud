import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { useRouter } from 'next/navigation';
import {
  updateOrgContextAtom,
  type OrgContext,
  type IndexedDbSessionData,
  type DbSessionDetails,
} from '../store/db-session-atoms';

/**
 * Command hook for applying organization context.
 * Handles persistence and navigation in one place.
 *
 * Separates concerns:
 * - Modal UI state: handled by parent component
 * - Persistence + navigation: handled here
 * - Orchestration: handled by CloudChatPage via callbacks
 */
export function useOrgContextCommand(organizationId?: string) {
  const updateOrgContext = useSetAtom(updateOrgContextAtom);
  const router = useRouter();

  /**
   * Apply organization context to a session.
   * This command:
   * 1. Persists org context to IndexedDB
   * 2. Navigates to correct org URL if needed
   * 3. Returns whether navigation occurred and session details for resume modal
   *
   * @returns Object indicating if navigation occurred and target session for modal
   */
  const applyOrgContext = useCallback(
    async (params: {
      orgContext: OrgContext | null;
      pendingSession: IndexedDbSessionData;
    }): Promise<{ navigated: boolean; targetSessionForModal: DbSessionDetails | null }> => {
      const { orgContext, pendingSession } = params;

      try {
        // 1. Update IndexedDB with confirmed org context
        await updateOrgContext({
          sessionId: pendingSession.sessionId,
          orgContext,
          orgContextConfirmed: true,
        });

        // 2. Check if we need to navigate to a DIFFERENT org
        const needsNavigation = orgContext && orgContext.organizationId !== organizationId;

        if (needsNavigation && orgContext) {
          // Navigate to the new org URL
          // The new page will handle showing ResumeConfigModal if needed
          // (orgContextConfirmed is preserved in IndexedDB, so only resume modal will show)
          const basePath = `/organizations/${orgContext.organizationId}/cloud`;
          router.push(`${basePath}/chat?sessionId=${pendingSession.sessionId}`);
          return { navigated: true, targetSessionForModal: null };
        }

        // 3. Either personal context OR same org selected
        // For CLI sessions, return session details so caller can show resume modal
        if (!pendingSession.cloudAgentSessionId) {
          const sessionForModal: DbSessionDetails = {
            session_id: pendingSession.sessionId,
            title: pendingSession.title,
            git_url: pendingSession.gitUrl,
            cloud_agent_session_id: pendingSession.cloudAgentSessionId,
            created_at: new Date(pendingSession.createdAt),
            updated_at: new Date(pendingSession.updatedAt),
            kilo_user_id: '',
            created_on_platform: 'unknown',
            forked_from: null,
            api_conversation_history_blob_url: null,
            task_metadata_blob_url: null,
            ui_messages_blob_url: null,
            git_state_blob_url: null,
            last_mode: pendingSession.lastMode,
            last_model: pendingSession.lastModel,
            // Use the newly confirmed orgContext, not the old pendingSession.orgContext
            organization_id: orgContext?.organizationId ?? null,
          };
          return { navigated: false, targetSessionForModal: sessionForModal };
        }

        return { navigated: false, targetSessionForModal: null };
      } catch (error) {
        console.error('Failed to apply org context:', error);
        throw error;
      }
    },
    [updateOrgContext, router, organizationId]
  );

  return { applyOrgContext };
}

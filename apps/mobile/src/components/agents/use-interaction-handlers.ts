import { useCallback, useState } from 'react';
import { toast } from 'sonner-native';

import {
  type AnalyticsSurface,
  captureEvent,
  PERMISSION_RESPONDED_EVENT,
  QUESTION_ANSWERED_EVENT,
} from '@/lib/analytics/posthog';
import { ackSessionAttention } from '@/lib/session-attention';

import { type useSessionManager } from './session-provider';

type InteractionHandlersArgs = {
  manager: ReturnType<typeof useSessionManager>;
  /**
   * Kilo session id (route `session-id` / list `session.id`). Keys the
   * attention ack store. Must not be the cloud-agent session id.
   */
  kiloSessionId: string;
  activeQuestion: { requestId: string; questions?: unknown[] } | null;
  activePermission: { requestId: string } | null;
  surface: AnalyticsSurface;
};

export function useInteractionHandlers({
  manager,
  kiloSessionId,
  activeQuestion,
  activePermission,
  surface,
}: InteractionHandlersArgs) {
  const [isAnswering, setIsAnswering] = useState(false);
  const [isRespondingToPermission, setIsRespondingToPermission] = useState(false);

  const handleAnswerQuestion = useCallback(
    async (answers: string[][]) => {
      if (!activeQuestion) {
        return;
      }
      setIsAnswering(true);
      try {
        await manager.answerQuestion(activeQuestion.requestId, answers);
        ackSessionAttention(kiloSessionId);
        captureEvent(QUESTION_ANSWERED_EVENT, { surface, skipped: false });
      } catch {
        toast.error('Failed to submit answer');
      } finally {
        setIsAnswering(false);
      }
    },
    [manager, kiloSessionId, activeQuestion, surface]
  );

  const handleRejectQuestion = useCallback(async () => {
    if (!activeQuestion) {
      return;
    }
    setIsAnswering(true);
    try {
      await manager.rejectQuestion(activeQuestion.requestId);
      ackSessionAttention(kiloSessionId);
      captureEvent(QUESTION_ANSWERED_EVENT, { surface, skipped: true });
    } catch {
      toast.error('Failed to skip question');
    } finally {
      setIsAnswering(false);
    }
  }, [manager, kiloSessionId, activeQuestion, surface]);

  const handleRespondToPermission = useCallback(
    async (response: 'once' | 'always' | 'reject') => {
      if (!activePermission) {
        return;
      }
      setIsRespondingToPermission(true);
      try {
        await manager.respondToPermission(activePermission.requestId, response);
        ackSessionAttention(kiloSessionId);
        captureEvent(PERMISSION_RESPONDED_EVENT, { surface, response });
      } catch {
        toast.error('Failed to respond to permission request');
      } finally {
        setIsRespondingToPermission(false);
      }
    },
    [manager, kiloSessionId, activePermission, surface]
  );

  return {
    isAnswering,
    isRespondingToPermission,
    handleAnswerQuestion,
    handleRejectQuestion,
    handleRespondToPermission,
  };
}

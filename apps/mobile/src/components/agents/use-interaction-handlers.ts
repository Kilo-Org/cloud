import { useCallback, useState } from 'react';
import { toast } from 'sonner-native';

import { announceForA11y } from '@/lib/a11y/announce';
import {
  type BlockingCardSubmissionError,
  classifyBlockingSubmissionError,
} from '@/components/agents/blocking-card-state';
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
  const [questionSubmissionError, setQuestionSubmissionError] = useState<{
    requestId: string;
    error: BlockingCardSubmissionError;
  } | null>(null);
  const [permissionSubmissionError, setPermissionSubmissionError] = useState<{
    requestId: string;
    error: BlockingCardSubmissionError;
  } | null>(null);

  const handleAnswerQuestion = useCallback(
    async (answers: string[][]) => {
      if (!activeQuestion) {
        return;
      }
      setQuestionSubmissionError(null);
      setIsAnswering(true);
      try {
        await manager.answerQuestion(activeQuestion.requestId, answers);
        ackSessionAttention(kiloSessionId);
        captureEvent(QUESTION_ANSWERED_EVENT, { surface, skipped: false });
      } catch (error) {
        const submissionError = classifyBlockingSubmissionError(error, 'question', 'answer');
        setQuestionSubmissionError({ requestId: activeQuestion.requestId, error: submissionError });
        announceForA11y(submissionError.message);
        toast.error(submissionError.message);
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
    setQuestionSubmissionError(null);
    setIsAnswering(true);
    try {
      await manager.rejectQuestion(activeQuestion.requestId);
      ackSessionAttention(kiloSessionId);
      captureEvent(QUESTION_ANSWERED_EVENT, { surface, skipped: true });
    } catch (error) {
      const submissionError = classifyBlockingSubmissionError(error, 'question', 'reject');
      setQuestionSubmissionError({ requestId: activeQuestion.requestId, error: submissionError });
      announceForA11y(submissionError.message);
      toast.error(submissionError.message);
    } finally {
      setIsAnswering(false);
    }
  }, [manager, kiloSessionId, activeQuestion, surface]);

  const handleRespondToPermission = useCallback(
    async (response: 'once' | 'always' | 'reject') => {
      if (!activePermission) {
        return;
      }
      setPermissionSubmissionError(null);
      setIsRespondingToPermission(true);
      try {
        await manager.respondToPermission(activePermission.requestId, response);
        ackSessionAttention(kiloSessionId);
        captureEvent(PERMISSION_RESPONDED_EVENT, { surface, response });
      } catch (error) {
        const submissionError = classifyBlockingSubmissionError(error, 'permission', 'respond');
        setPermissionSubmissionError({
          requestId: activePermission.requestId,
          error: submissionError,
        });
        announceForA11y(submissionError.message);
        toast.error(submissionError.message);
      } finally {
        setIsRespondingToPermission(false);
      }
    },
    [manager, kiloSessionId, activePermission, surface]
  );

  return {
    isAnswering,
    isRespondingToPermission,
    questionSubmissionError:
      questionSubmissionError != null &&
      questionSubmissionError.requestId === activeQuestion?.requestId
        ? questionSubmissionError.error
        : null,
    permissionSubmissionError:
      permissionSubmissionError != null &&
      permissionSubmissionError.requestId === activePermission?.requestId
        ? permissionSubmissionError.error
        : null,
    handleAnswerQuestion,
    handleRejectQuestion,
    handleRespondToPermission,
  };
}

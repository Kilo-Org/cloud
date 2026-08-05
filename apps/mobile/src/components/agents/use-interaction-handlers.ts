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
  const [answeringRequestId, setAnsweringRequestId] = useState<string | null>(null);
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
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
      const requestId = activeQuestion.requestId;
      setQuestionSubmissionError(null);
      setAnsweringRequestId(requestId);
      try {
        await manager.answerQuestion(requestId, answers);
        ackSessionAttention(kiloSessionId);
        captureEvent(QUESTION_ANSWERED_EVENT, { surface, skipped: false });
      } catch (error) {
        const submissionError = classifyBlockingSubmissionError(error, 'question', 'answer');
        setQuestionSubmissionError({ requestId, error: submissionError });
        announceForA11y(submissionError.message);
        toast.error(submissionError.message);
      } finally {
        // Guarded clear. The head can advance mid-flight, the user can submit the
        // next request, and this late `finally` must not drop that newer spinner.
        setAnsweringRequestId(current => (current === requestId ? null : current));
      }
    },
    [manager, kiloSessionId, activeQuestion, surface]
  );

  const handleRejectQuestion = useCallback(async () => {
    if (!activeQuestion) {
      return;
    }
    const requestId = activeQuestion.requestId;
    setQuestionSubmissionError(null);
    setAnsweringRequestId(requestId);
    try {
      await manager.rejectQuestion(requestId);
      ackSessionAttention(kiloSessionId);
      captureEvent(QUESTION_ANSWERED_EVENT, { surface, skipped: true });
    } catch (error) {
      const submissionError = classifyBlockingSubmissionError(error, 'question', 'reject');
      setQuestionSubmissionError({ requestId, error: submissionError });
      announceForA11y(submissionError.message);
      toast.error(submissionError.message);
    } finally {
      setAnsweringRequestId(current => (current === requestId ? null : current));
    }
  }, [manager, kiloSessionId, activeQuestion, surface]);

  const handleRespondToPermission = useCallback(
    async (response: 'once' | 'always' | 'reject') => {
      if (!activePermission) {
        return;
      }
      const requestId = activePermission.requestId;
      setPermissionSubmissionError(null);
      setRespondingRequestId(requestId);
      try {
        await manager.respondToPermission(requestId, response);
        ackSessionAttention(kiloSessionId);
        captureEvent(PERMISSION_RESPONDED_EVENT, { surface, response });
      } catch (error) {
        const submissionError = classifyBlockingSubmissionError(error, 'permission', 'respond');
        setPermissionSubmissionError({
          requestId,
          error: submissionError,
        });
        announceForA11y(submissionError.message);
        toast.error(submissionError.message);
      } finally {
        setRespondingRequestId(current => (current === requestId ? null : current));
      }
    },
    [manager, kiloSessionId, activePermission, surface]
  );

  return {
    // Scoped to the request in flight. When the queue head advances
    // mid-flight, the next card must mount interactive, not wearing the
    // previous request's spinner.
    isAnswering: answeringRequestId != null && answeringRequestId === activeQuestion?.requestId,
    isRespondingToPermission:
      respondingRequestId != null && respondingRequestId === activePermission?.requestId,
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

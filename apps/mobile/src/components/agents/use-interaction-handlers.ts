import { useCallback, useState } from 'react';
import { toast } from 'sonner-native';

import { type useSessionManager } from './session-provider';

type InteractionHandlersArgs = {
  manager: ReturnType<typeof useSessionManager>;
  activeQuestion: { requestId: string; questions?: unknown[] } | null;
  activePermission: { requestId: string } | null;
};

export function useInteractionHandlers({
  manager,
  activeQuestion,
  activePermission,
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
      } catch {
        toast.error('Failed to submit answer');
      } finally {
        setIsAnswering(false);
      }
    },
    [manager, activeQuestion]
  );

  const handleRejectQuestion = useCallback(async () => {
    if (!activeQuestion) {
      return;
    }
    setIsAnswering(true);
    try {
      await manager.rejectQuestion(activeQuestion.requestId);
    } catch {
      toast.error('Failed to skip question');
    } finally {
      setIsAnswering(false);
    }
  }, [manager, activeQuestion]);

  const handleRespondToPermission = useCallback(
    async (response: 'once' | 'always' | 'reject') => {
      if (!activePermission) {
        return;
      }
      setIsRespondingToPermission(true);
      try {
        await manager.respondToPermission(activePermission.requestId, response);
      } catch {
        toast.error('Failed to respond to permission request');
      } finally {
        setIsRespondingToPermission(false);
      }
    },
    [manager, activePermission]
  );

  return {
    isAnswering,
    isRespondingToPermission,
    handleAnswerQuestion,
    handleRejectQuestion,
    handleRespondToPermission,
  };
}

import { type ExecApprovalDecision, formatKiloChatError, type Message } from '@kilocode/kilo-chat';
import { toast } from 'sonner-native';

type ExecuteActionVariables = {
  messageId: string;
  groupId: string;
  value: ExecApprovalDecision;
};

type ExecuteActionMutation = {
  mutate: (
    variables: ExecuteActionVariables,
    options?: { onError?: (err: unknown) => void }
  ) => void;
};

export function executeActionWithMobileFeedback({
  executeAction,
  message,
  groupId,
  value,
}: {
  executeAction: ExecuteActionMutation;
  message: Message;
  groupId: string;
  value: ExecApprovalDecision;
}) {
  executeAction.mutate(
    { messageId: message.id, groupId, value },
    {
      onError: err => {
        toast.error(formatKiloChatError(err, 'Failed to execute action'));
      },
    }
  );
}

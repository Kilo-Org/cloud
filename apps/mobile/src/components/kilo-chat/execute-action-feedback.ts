import { type ExecApprovalDecision, type Message } from '@kilocode/kilo-chat';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';

import { formatMobileKiloChatError } from './kilo-chat-error';

type ExecuteActionVariables = {
  messageId: string;
  groupId: string;
  value: ExecApprovalDecision;
};

type ExecuteActionMutation = {
  mutate: (
    variables: ExecuteActionVariables,
    options?: {
      onError?: (err: unknown) => void;
      onSettled?: () => void;
    }
  ) => void;
};

export function executeActionWithMobileFeedback({
  executeAction,
  message,
  groupId,
  value,
  onSettled,
}: {
  executeAction: ExecuteActionMutation;
  message: Message;
  groupId: string;
  value: ExecApprovalDecision;
  onSettled?: () => void;
}) {
  const options = {
    onError: (err: unknown) => {
      toast.error(formatMobileKiloChatError(err, i18n.t('chat.messageActions.executeFailed')));
    },
    ...(onSettled ? { onSettled } : {}),
  };
  executeAction.mutate({ messageId: message.id, groupId, value }, options);
}

import { type ChatComposerParseResult } from '@/components/agents/chat-composer-slash-commands';
import { confirmRemoteCliExit } from '@/components/agents/remote-cli-exit-confirmation';

/**
 * Submission types that have passed validation and are ready to execute.
 * Attachment, argument, and upgrade-required errors are handled before the
 * composer reaches this stage.
 */
export type ExecutableChatComposerSubmission = Extract<
  ChatComposerParseResult,
  { type: 'command' } | { type: 'create-session' } | { type: 'exit-cli' } | { type: 'prompt' }
>;

type ChatComposerSubmissionHandlers = {
  onSendCommand: (command: string, argumentsText: string) => Promise<boolean>;
  onCreateSession: () => Promise<boolean>;
  onExitCli: (onAccepted: () => void) => Promise<void>;
  confirmExitCli: () => Promise<boolean>;
  onSendPrompt: (prompt: string) => Promise<void>;
};

type ChatComposerSubmissionCleanup = {
  clearDraft: () => void;
  resetAttachments: () => void;
  dismiss: () => void;
};

/**
 * Execute the outcome of `parseChatComposerSubmission`.
 *
 * The caller owns validation, locking, and feedback (toasts/haptics). This
 * helper only orchestrates callbacks and cleanup, and it rejects on any failure
 * so the caller can preserve the composer draft.
 */
export async function executeChatComposerSubmission(
  submission: ExecutableChatComposerSubmission,
  handlers: ChatComposerSubmissionHandlers,
  cleanup: ChatComposerSubmissionCleanup
): Promise<void> {
  if (submission.type === 'command') {
    const accepted = await handlers.onSendCommand(submission.command, submission.arguments);
    if (!accepted) {
      throw new Error('Command send rejected');
    }
    cleanup.clearDraft();
    cleanup.dismiss();
    return;
  }

  if (submission.type === 'create-session') {
    const accepted = await handlers.onCreateSession();
    if (!accepted) {
      throw new Error('Create session rejected');
    }
    cleanup.clearDraft();
    cleanup.dismiss();
    return;
  }

  if (submission.type === 'exit-cli') {
    await confirmRemoteCliExit(handlers.confirmExitCli, async () => {
      await handlers.onExitCli(() => {
        cleanup.clearDraft();
        cleanup.dismiss();
      });
    });
    return;
  }

  await handlers.onSendPrompt(submission.prompt);
  cleanup.clearDraft();
  cleanup.resetAttachments();
  cleanup.dismiss();
}

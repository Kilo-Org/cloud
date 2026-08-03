import { describe, expect, it, vi } from 'vitest';

import {
  type ExecutableChatComposerSubmission,
  executeChatComposerSubmission,
} from '@/components/agents/chat-composer-submission';

type CommandSubmission = Extract<ExecutableChatComposerSubmission, { type: 'command' }>;
type PromptSubmission = Extract<ExecutableChatComposerSubmission, { type: 'prompt' }>;

function makeCommandSubmission(
  overrides: Partial<CommandSubmission> = {}
): ExecutableChatComposerSubmission {
  return { type: 'command', command: 'review', arguments: 'main', ...overrides };
}

function makePromptSubmission(
  overrides: Partial<PromptSubmission> = {}
): ExecutableChatComposerSubmission {
  return { type: 'prompt', prompt: 'hello', ...overrides };
}

function makeCleanup() {
  return {
    clearDraft: vi.fn(),
    resetAttachments: vi.fn(),
    dismiss: vi.fn(),
  };
}

function makeHandlers(
  overrides: {
    onSendCommand?: () => Promise<boolean>;
    onSendPrompt?: () => Promise<void>;
  } = {}
) {
  return {
    onSendCommand: vi.fn(
      overrides.onSendCommand ??
        (async () => {
          await Promise.resolve();
          return true;
        })
    ),
    onSendPrompt: vi.fn(
      overrides.onSendPrompt ??
        (async () => {
          await Promise.resolve();
        })
    ),
    onCreateSession: vi.fn(async () => {
      await Promise.resolve();
      return true;
    }),
    onExitSession: vi.fn(async (_onAccepted: () => void) => {
      await Promise.resolve();
    }),
    onRestartSession: vi.fn(async () => {
      await Promise.resolve();
      return true;
    }),
    confirmExitSession: vi.fn(async () => {
      await Promise.resolve();
      return true;
    }),
  };
}

describe('executeChatComposerSubmission', () => {
  describe('command submission', () => {
    it('clears the draft and dismisses once when the command is accepted', async () => {
      const handlers = makeHandlers({
        onSendCommand: async () => {
          await Promise.resolve();
          return true;
        },
      });
      const cleanup = makeCleanup();

      await executeChatComposerSubmission(
        makeCommandSubmission({ command: 'review', arguments: 'main' }),
        handlers,
        cleanup
      );

      expect(handlers.onSendCommand).toHaveBeenCalledTimes(1);
      expect(handlers.onSendCommand).toHaveBeenCalledWith('review', 'main');
      expect(cleanup.clearDraft).toHaveBeenCalledTimes(1);
      expect(cleanup.dismiss).toHaveBeenCalledTimes(1);
      expect(cleanup.resetAttachments).not.toHaveBeenCalled();
    });

    it('preserves draft and dismisses nothing when the command is rejected', async () => {
      const handlers = makeHandlers({
        onSendCommand: async () => {
          await Promise.resolve();
          return false;
        },
      });
      const cleanup = makeCleanup();

      await expect(
        executeChatComposerSubmission(
          makeCommandSubmission({ command: 'compact', arguments: '' }),
          handlers,
          cleanup
        )
      ).rejects.toThrow('Command send rejected');

      expect(cleanup.clearDraft).not.toHaveBeenCalled();
      expect(cleanup.dismiss).not.toHaveBeenCalled();
      expect(cleanup.resetAttachments).not.toHaveBeenCalled();
    });

    it('propagates rejection without cleanup when the command throws', async () => {
      const handlers = makeHandlers({
        onSendCommand: async () => {
          await Promise.resolve();
          throw new Error('transport failed');
        },
      });
      const cleanup = makeCleanup();

      await expect(
        executeChatComposerSubmission(
          makeCommandSubmission({ command: 'compact', arguments: '' }),
          handlers,
          cleanup
        )
      ).rejects.toThrow('transport failed');

      expect(cleanup.clearDraft).not.toHaveBeenCalled();
      expect(cleanup.dismiss).not.toHaveBeenCalled();
      expect(cleanup.resetAttachments).not.toHaveBeenCalled();
    });
  });

  describe('prompt submission', () => {
    it('clears the draft, resets attachments, and dismisses once when the prompt resolves', async () => {
      const handlers = makeHandlers({
        onSendPrompt: async () => {
          await Promise.resolve();
        },
      });
      const cleanup = makeCleanup();

      await executeChatComposerSubmission(
        makePromptSubmission({ prompt: 'hello world' }),
        handlers,
        cleanup
      );

      expect(handlers.onSendPrompt).toHaveBeenCalledTimes(1);
      expect(handlers.onSendPrompt).toHaveBeenCalledWith('hello world');
      expect(cleanup.clearDraft).toHaveBeenCalledTimes(1);
      expect(cleanup.resetAttachments).toHaveBeenCalledTimes(1);
      expect(cleanup.dismiss).toHaveBeenCalledTimes(1);
    });

    it('preserves draft and attachments when the prompt send rejects', async () => {
      const handlers = makeHandlers({
        onSendPrompt: async () => {
          await Promise.resolve();
          throw new Error('rate limited');
        },
      });
      const cleanup = makeCleanup();

      await expect(
        executeChatComposerSubmission(makePromptSubmission({ prompt: 'hello' }), handlers, cleanup)
      ).rejects.toThrow('rate limited');

      expect(cleanup.clearDraft).not.toHaveBeenCalled();
      expect(cleanup.resetAttachments).not.toHaveBeenCalled();
      expect(cleanup.dismiss).not.toHaveBeenCalled();
    });
  });
});

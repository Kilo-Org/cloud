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

function makeCreateSessionSubmission(): ExecutableChatComposerSubmission {
  return { type: 'create-session' };
}

function makeExitSessionSubmission(): ExecutableChatComposerSubmission {
  return { type: 'exit-session' };
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
    onCreateSession?: () => Promise<boolean>;
    onExitSession?: (onAccepted: () => void) => Promise<void>;
    confirmExitSession?: () => Promise<boolean>;
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
    onCreateSession: vi.fn(
      overrides.onCreateSession ??
        (async () => {
          await Promise.resolve();
          return true;
        })
    ),
    onExitSession: vi.fn(
      overrides.onExitSession ??
        (async onAccepted => {
          await Promise.resolve();
          onAccepted();
        })
    ),
    confirmExitSession: vi.fn(
      overrides.confirmExitSession ??
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

  describe('create-session submission', () => {
    it('clears the draft and dismisses once when creation is accepted', async () => {
      const handlers = makeHandlers({
        onCreateSession: async () => {
          await Promise.resolve();
          return true;
        },
      });
      const cleanup = makeCleanup();

      await executeChatComposerSubmission(makeCreateSessionSubmission(), handlers, cleanup);

      expect(handlers.onCreateSession).toHaveBeenCalledTimes(1);
      expect(cleanup.clearDraft).toHaveBeenCalledTimes(1);
      expect(cleanup.dismiss).toHaveBeenCalledTimes(1);
      expect(cleanup.resetAttachments).not.toHaveBeenCalled();
    });

    it('preserves draft and dismisses nothing when creation is rejected', async () => {
      const handlers = makeHandlers({
        onCreateSession: async () => {
          await Promise.resolve();
          return false;
        },
      });
      const cleanup = makeCleanup();

      await expect(
        executeChatComposerSubmission(makeCreateSessionSubmission(), handlers, cleanup)
      ).rejects.toThrow('Create session rejected');

      expect(cleanup.clearDraft).not.toHaveBeenCalled();
      expect(cleanup.dismiss).not.toHaveBeenCalled();
      expect(cleanup.resetAttachments).not.toHaveBeenCalled();
    });

    it('propagates rejection without cleanup when creation throws', async () => {
      const handlers = makeHandlers({
        onCreateSession: async () => {
          await Promise.resolve();
          throw new Error('cli unavailable');
        },
      });
      const cleanup = makeCleanup();

      await expect(
        executeChatComposerSubmission(makeCreateSessionSubmission(), handlers, cleanup)
      ).rejects.toThrow('cli unavailable');

      expect(cleanup.clearDraft).not.toHaveBeenCalled();
      expect(cleanup.dismiss).not.toHaveBeenCalled();
      expect(cleanup.resetAttachments).not.toHaveBeenCalled();
    });
  });

  describe('exit-session submission', () => {
    it('does no cleanup and never exits when confirmation is cancelled', async () => {
      const handlers = makeHandlers({
        confirmExitSession: async () => {
          await Promise.resolve();
          return false;
        },
      });
      const cleanup = makeCleanup();

      await executeChatComposerSubmission(makeExitSessionSubmission(), handlers, cleanup);

      expect(handlers.confirmExitSession).toHaveBeenCalledTimes(1);
      expect(handlers.onExitSession).not.toHaveBeenCalled();
      expect(cleanup.clearDraft).not.toHaveBeenCalled();
      expect(cleanup.dismiss).not.toHaveBeenCalled();
      expect(cleanup.resetAttachments).not.toHaveBeenCalled();
    });

    it('awaits confirmation and exit before clearing the draft and dismissing', async () => {
      const order: string[] = [];
      const handlers = makeHandlers({
        confirmExitSession: async () => {
          order.push('confirm');
          await Promise.resolve();
          return true;
        },
        onExitSession: async onAccepted => {
          order.push('exit');
          await Promise.resolve();
          onAccepted();
        },
      });
      const cleanup = {
        clearDraft: vi.fn(() => order.push('clear')),
        resetAttachments: vi.fn(() => order.push('reset')),
        dismiss: vi.fn(() => order.push('dismiss')),
      };

      await executeChatComposerSubmission(makeExitSessionSubmission(), handlers, cleanup);

      expect(order).toEqual(['confirm', 'exit', 'clear', 'dismiss']);
      expect(handlers.onExitSession).toHaveBeenCalledTimes(1);
      expect(cleanup.resetAttachments).not.toHaveBeenCalled();
    });

    it('preserves the draft and keyboard when confirmed exit fails', async () => {
      const handlers = makeHandlers({
        onExitSession: async () => {
          await Promise.resolve();
          throw new Error('CLI is already offline');
        },
      });
      const cleanup = makeCleanup();

      await expect(
        executeChatComposerSubmission(makeExitSessionSubmission(), handlers, cleanup)
      ).rejects.toThrow('CLI is already offline');

      expect(handlers.onExitSession).toHaveBeenCalledTimes(1);
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

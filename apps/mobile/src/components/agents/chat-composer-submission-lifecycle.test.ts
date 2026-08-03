import { describe, expect, it, vi } from 'vitest';

import { executeChatComposerSubmission } from '@/components/agents/chat-composer-submission';

function makeCleanup() {
  return {
    clearDraft: vi.fn(),
    resetAttachments: vi.fn(),
    dismiss: vi.fn(),
  };
}

function makeHandlers(
  overrides: {
    onCreateSession?: () => Promise<boolean>;
    onExitSession?: (onAccepted: () => void) => Promise<void>;
    onRestartSession?: () => Promise<boolean>;
    confirmExitSession?: () => Promise<boolean>;
  } = {}
) {
  return {
    onSendCommand: vi.fn(),
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
    onRestartSession: vi.fn(
      overrides.onRestartSession ??
        (async () => {
          await Promise.resolve();
          return true;
        })
    ),
    confirmExitSession: vi.fn(
      overrides.confirmExitSession ??
        (async () => {
          await Promise.resolve();
          return true;
        })
    ),
    onSendPrompt: vi.fn(),
  };
}

function makeCreateSessionSubmission() {
  return { type: 'create-session' as const };
}

function makeExitSessionSubmission() {
  return { type: 'exit-session' as const };
}

function makeRestartSessionSubmission() {
  return { type: 'restart-session' as const };
}

describe('executeChatComposerSubmission', () => {
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

  describe('restart-session submission', () => {
    it('clears the draft and dismisses once when restart is accepted', async () => {
      const handlers = makeHandlers({
        onRestartSession: async () => {
          await Promise.resolve();
          return true;
        },
      });
      const cleanup = makeCleanup();

      await executeChatComposerSubmission(makeRestartSessionSubmission(), handlers, cleanup);

      expect(handlers.onRestartSession).toHaveBeenCalledTimes(1);
      expect(cleanup.clearDraft).toHaveBeenCalledTimes(1);
      expect(cleanup.dismiss).toHaveBeenCalledTimes(1);
      expect(cleanup.resetAttachments).not.toHaveBeenCalled();
    });

    it('preserves draft and dismisses nothing when restart is rejected', async () => {
      const handlers = makeHandlers({
        onRestartSession: async () => {
          await Promise.resolve();
          return false;
        },
      });
      const cleanup = makeCleanup();

      await expect(
        executeChatComposerSubmission(makeRestartSessionSubmission(), handlers, cleanup)
      ).rejects.toThrow('Restart session rejected');

      expect(cleanup.clearDraft).not.toHaveBeenCalled();
      expect(cleanup.dismiss).not.toHaveBeenCalled();
      expect(cleanup.resetAttachments).not.toHaveBeenCalled();
    });

    it('propagates rejection without cleanup when restart throws', async () => {
      const handlers = makeHandlers({
        onRestartSession: async () => {
          await Promise.resolve();
          throw new Error('create failed');
        },
      });
      const cleanup = makeCleanup();

      await expect(
        executeChatComposerSubmission(makeRestartSessionSubmission(), handlers, cleanup)
      ).rejects.toThrow('create failed');

      expect(cleanup.clearDraft).not.toHaveBeenCalled();
      expect(cleanup.dismiss).not.toHaveBeenCalled();
      expect(cleanup.resetAttachments).not.toHaveBeenCalled();
    });
  });
});

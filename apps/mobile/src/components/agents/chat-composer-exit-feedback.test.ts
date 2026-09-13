import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner-native';

import { parseChatComposerSubmission } from '@/components/agents/chat-composer-slash-commands';
import { executeChatComposerSubmission } from '@/components/agents/chat-composer-submission';
import { exitRemoteSessionWithFeedback } from '@/components/agents/exit-remote-session-with-feedback';
import { i18n } from '@/i18n';

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function createHarness(command: string) {
  const submission = parseChatComposerSubmission(`/${command}`, [], {
    hasAttachments: false,
    sessionType: 'remote',
    remoteCommandState: {
      ownerConnectionId: 'conn-1',
      refresh: 'idle',
      commands: [],
      canExitSession: true,
    },
  });
  expect(submission).toEqual({ type: 'exit-session' });
  if (submission.type !== 'exit-session') {
    throw new Error('Expected the shared exit-session action');
  }

  const exit = vi.fn<() => Promise<void>>();
  const router = { dismissTo: vi.fn() };
  const lock = { current: false };
  const cleanup = { clearDraft: vi.fn(), dismiss: vi.fn() };
  const handlers = {
    confirmExitSession: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    onExitSession: async (onAccepted: () => void) => {
      await exitRemoteSessionWithFeedback({ exit, onAccepted, router, lock });
    },
    onSendCommand: vi.fn(),
    onSendPrompt: vi.fn(),
    onCreateSession: vi.fn(),
    onRestartSession: vi.fn(),
  };
  return { submission, exit, router, lock, cleanup, handlers };
}

describe.each(['exit', 'quit'])('/%s shares exit feedback and recovery', command => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves the draft on transport failure and exits once when Try again succeeds', async () => {
    const { submission, exit, router, lock, cleanup, handlers } = createHarness(command);
    exit.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValue(undefined);

    await expect(executeChatComposerSubmission(submission, handlers, cleanup)).rejects.toThrow(
      'connection reset'
    );

    expect(cleanup.clearDraft).not.toHaveBeenCalled();
    expect(cleanup.dismiss).not.toHaveBeenCalled();
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('connection reset', {
      action: { label: 'Try again', onClick: expect.any(Function) },
    });
    const options = vi.mocked(toast.error).mock.calls[0]?.[1];
    if (!options?.action || typeof options.action !== 'object' || !('onClick' in options.action)) {
      throw new Error('Expected a working retry action');
    }

    options.action.onClick();
    await vi.waitFor(() => {
      expect(router.dismissTo).toHaveBeenCalledWith('/(app)/(tabs)/(2_agents)');
    });
    expect(exit).toHaveBeenCalledTimes(2);
    expect(handlers.confirmExitSession).toHaveBeenCalledTimes(1);
    expect(handlers.onSendCommand).not.toHaveBeenCalled();
    expect(handlers.onSendPrompt).not.toHaveBeenCalled();
    expect(cleanup.clearDraft).toHaveBeenCalledTimes(1);
    expect(cleanup.dismiss).toHaveBeenCalledTimes(1);
    expect(router.dismissTo).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Session exited');
    expect(lock.current).toBe(false);
  });

  it.each([
    [
      'Remote session exit is not supported for the current session',
      'agentChat.remoteSession.exitNotSupported',
    ],
    [
      'Remote session exit is unavailable for the current session',
      'agentChat.remoteSession.exitUnavailable',
    ],
    [
      'Remote slash commands require a newer Kilo CLI. Update Kilo CLI and reconnect.',
      'agentChat.remoteSession.exitNeedsNewerCli',
    ],
  ])('preserves the draft and shows no retry CTA for %s', async (message, copyKey) => {
    const { submission, exit, router, cleanup, handlers } = createHarness(command);
    exit.mockRejectedValue(new Error(message));

    await expect(executeChatComposerSubmission(submission, handlers, cleanup)).rejects.toThrow(
      message
    );

    expect(toast.error).toHaveBeenCalledExactlyOnceWith(i18n.t(copyKey));
    expect(toast.success).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(handlers.confirmExitSession).toHaveBeenCalledTimes(1);
    expect(handlers.onSendCommand).not.toHaveBeenCalled();
    expect(handlers.onSendPrompt).not.toHaveBeenCalled();
    expect(cleanup.clearDraft).not.toHaveBeenCalled();
    expect(cleanup.dismiss).not.toHaveBeenCalled();
    expect(router.dismissTo).not.toHaveBeenCalled();
  });
});

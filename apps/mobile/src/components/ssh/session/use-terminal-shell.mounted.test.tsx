import { createElement, type RefObject } from 'react';
import { expect, it, vi } from 'vitest';

import { type TerminalViewHandle } from '../../../../modules/kilo-ssh/src';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { type SshSession } from '@/lib/ssh/session/types';

import { useTerminalShell } from './use-terminal-shell';

const state = vi.hoisted(() => ({ consume: vi.fn() }));
vi.mock('@/lib/ssh/session/manager', () => ({ consumePendingCommand: state.consume }));

type Controls = {
  terminalRef: RefObject<TerminalViewHandle | null>;
  displayedShellId: string | null;
  inputReady: boolean;
  onLayout: () => void;
  onSourceBound: (sourceId: string) => void;
};

function Probe({ session }: { session: SshSession }) {
  return createElement('Probe', useTerminalShell(session.id, session));
}

function controls(renderer: ReactTestRenderer): Controls {
  return renderer.root.findByType('Probe').props as Controls;
}

it('waits for the replacement source to bind before sending tmux startup', async () => {
  const session: SshSession = {
    id: 'session',
    hostId: 'host',
    label: 'fixture',
    target: 'user@fixture:22',
    startedAt: 1,
    phase: { kind: 'connected' },
    shellId: 'shell-1',
    nativeSessionId: 'native-1',
    pendingCommand: null,
  };
  const held: { renderer?: ReactTestRenderer } = {};
  await act(async () => {
    held.renderer = TestRenderer.create(createElement(Probe, { session }));
    await Promise.resolve();
  });
  const renderer = held.renderer;
  if (renderer === undefined) {
    throw new Error('Probe did not mount');
  }
  const sendInput = vi.fn().mockResolvedValue(undefined);
  const noOp = vi.fn().mockResolvedValue(undefined);
  try {
    act(() => {
      controls(renderer).terminalRef.current = {
        sendInput,
        blur: noOp,
        focus: noOp,
        copySelection: noOp,
        paste: noOp,
        pasteFromClipboard: noOp,
        scrollToBottom: noOp,
      };
      controls(renderer).onLayout();
      controls(renderer).onSourceBound('shell-1');
    });
    act(() => {
      renderer.update(
        createElement(Probe, {
          session: {
            ...session,
            shellId: null,
            phase: { kind: 'reconnecting', attempt: 2, reason: 'Network' },
          },
        })
      );
    });
    expect(controls(renderer).displayedShellId).toBe('shell-1');
    act(() => {
      renderer.update(
        createElement(Probe, {
          session: { ...session, shellId: 'shell-2', pendingCommand: 'tmux attach\r' },
        })
      );
    });
    expect(sendInput).not.toHaveBeenCalled();
    expect(controls(renderer).inputReady).toBe(false);
    await act(async () => {
      controls(renderer).onSourceBound('shell-2');
      await Promise.resolve();
    });
    expect(sendInput).toHaveBeenCalledOnce();
    expect(controls(renderer).inputReady).toBe(true);
    expect(state.consume).toHaveBeenCalledWith('session', 'tmux attach\r');
  } finally {
    act(() => {
      renderer.unmount();
    });
  }
});

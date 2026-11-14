import { type TerminalViewHandle } from '../../../../modules/kilo-ssh/src';
import { useEffect, useRef, useState } from 'react';

import { consumePendingCommand } from '@/lib/ssh/session/manager';
import { sessionSurface } from '@/lib/ssh/session/surface';
import { type SshSession } from '@/lib/ssh/session/types';
import { encodeTerminalInput } from '@/lib/ssh/terminal-bytes';

import { blurShell, startupCommandForShell } from './terminal-input';

export function useTerminalShell(sessionId: string, session: SshSession | null) {
  const terminalRef = useRef<TerminalViewHandle>(null);
  const [laidOut, setLaidOut] = useState(false);
  const lastShell = useRef<{ sessionId: string; shellId: string } | null>(null);
  const firstShellId = useRef<string | null>(null);
  const shellId = session?.shellId ?? null;
  if (shellId !== null) {
    lastShell.current = { sessionId, shellId };
    firstShellId.current ??= shellId;
  }
  const displayedShellId =
    lastShell.current?.sessionId === sessionId ? lastShell.current.shellId : null;
  const surface =
    session === null ? null : sessionSurface(session.phase, displayedShellId !== null);
  const pendingCommand = session?.pendingCommand ?? null;

  useEffect(() => {
    if (surface?.reconnecting) {
      void blurShell(terminalRef.current);
    }
  }, [surface?.reconnecting]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const command = startupCommandForShell(shellId, laidOut ? shellId : null, pendingCommand);
    if (command === null || terminal === null) {
      return;
    }
    void typeOnce(terminal, sessionId, command);
  }, [pendingCommand, shellId, laidOut, sessionId]);

  return {
    terminalRef,
    displayedShellId,
    surface,
    autoFocus: displayedShellId === firstShellId.current && !surface?.reconnecting,
    onLayout: () => {
      setLaidOut(true);
    },
  };
}

async function typeOnce(
  terminal: TerminalViewHandle,
  sessionId: string,
  command: string
): Promise<void> {
  try {
    await terminal.sendInput(encodeTerminalInput(command));
    consumePendingCommand(sessionId, command);
  } catch {
    // A shell can close before its startup command reaches the native view.
  }
}

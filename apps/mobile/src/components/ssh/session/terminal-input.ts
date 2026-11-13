import { type TerminalViewHandle } from '../../../../modules/kilo-ssh/src';

import { encodeTerminalInput } from '@/lib/ssh/terminal-bytes';

/**
 * Typing into a live shell, where a closed shell is not an error this screen
 * can act on: the pty may end between the tap and the write.
 */
export async function sendToShell(
  terminal: TerminalViewHandle | null,
  text: string
): Promise<void> {
  try {
    await terminal?.sendInput(encodeTerminalInput(text));
  } catch {
    // The shell closed under this key.
  }
}

/** Sends pasted text through the view's own paste, ignoring a closed shell. */
export async function pasteToShell(
  terminal: TerminalViewHandle | null,
  text: string
): Promise<void> {
  try {
    await terminal?.paste(text);
  } catch {
    // The shell closed before the paste.
  }
}

/** Native terminal focus is separate from React Native's TextInput focus. */
export async function blurShell(terminal: TerminalViewHandle | null): Promise<void> {
  try {
    await terminal?.blur();
  } catch {
    // The view was removed before the blur reached it.
  }
}

/** A ref exists before Fabric has mounted the native view that can accept commands. */
export function startupCommandForShell(
  shellId: string | null,
  laidOutShellId: string | null,
  pendingCommand: string | null
): string | null {
  return shellId !== null && shellId === laidOutShellId ? pendingCommand : null;
}

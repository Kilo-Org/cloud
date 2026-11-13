import { type TerminalViewHandle } from '@kilocode/react-native-ssh';

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

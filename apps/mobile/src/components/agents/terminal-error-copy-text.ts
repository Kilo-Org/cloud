/**
 * Build the clipboard text for a terminal error: session id, then what the
 * reader saw, then the untranslated original that support needs.
 */
export function buildTerminalErrorCopyText(input: {
  sessionId: string;
  title: string;
  message: string;
  /** The untranslated original. Omitted when the message already is it. */
  detail?: string;
}): string {
  const { sessionId, title, message, detail } = input;
  return [sessionId, title, message, detail === message ? '' : detail].filter(Boolean).join('\n');
}

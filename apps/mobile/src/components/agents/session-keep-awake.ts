/**
 * Wake-lock window for the session screen.
 *
 * The preference only gates the existing window; it never widens it. Focus bounds
 * the window to the visible working UI, so a backgrounded or covered screen never
 * holds the OS idle timer.
 */
export function shouldKeepSessionAwake(
  input: Readonly<{
    keepScreenOn: boolean;
    /** False until the stored preference has been read; treated as "not yet on". */
    preferenceLoaded: boolean;
    isFocused: boolean;
    isDisconnected: boolean;
    isStreaming: boolean;
    pendingMessageCount: number;
  }>
): boolean {
  return (
    input.keepScreenOn &&
    input.preferenceLoaded &&
    input.isFocused &&
    !input.isDisconnected &&
    (input.isStreaming || input.pendingMessageCount > 0)
  );
}

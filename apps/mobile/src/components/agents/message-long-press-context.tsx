import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { type StoredMessage } from '@kilocode/cloud-agent-sdk';

/**
 * Message-level long-press for interactive rows inside a message bubble.
 * Mounted by `MessageLongPressProvider` when the message-details sheet is
 * wired; `FixedPartRow` reads it so a long press that lands on a part row
 * opens the message-details sheet instead of being swallowed by the row's own
 * tap responder — during a reasoning-heavy stream the reasoning row is the
 * only rendered part, so the bubble's long-press contract ("long press for
 * details") is otherwise unreachable exactly while the message streams.
 * Lives in its own module with no component imports so the card split
 * compiles before the sheet infrastructure exists.
 */
export const MessageLongPressContext = createContext<(() => void) | null>(null);

export function useMessageLongPress(): (() => void) | null {
  return useContext(MessageLongPressContext);
}

/**
 * Mounts the part-rows' message-level long-press for one assistant message.
 * A separate component so the value can be memoized with a hook —
 * `MessageBubble` is also inspected as an unrendered element tree, where
 * hooks cannot run.
 */
export function MessageLongPressProvider({
  message,
  onLongPressDetails,
  children,
}: Readonly<{
  message: StoredMessage;
  onLongPressDetails?: (message: StoredMessage) => void;
  children?: ReactNode;
}>): ReactNode {
  const messageLongPress = useMemo(
    () =>
      onLongPressDetails
        ? () => {
            onLongPressDetails(message);
          }
        : null,
    [onLongPressDetails, message]
  );

  return (
    <MessageLongPressContext.Provider value={messageLongPress}>
      {children}
    </MessageLongPressContext.Provider>
  );
}

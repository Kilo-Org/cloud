import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
} from "react";
import { StyleSheet } from "react-native";
import type {
  PylonChatViewInternalRef,
  PylonChatViewRef,
} from "./PylonChatView";
import { PylonChatView } from "./PylonChatView";
import type { PylonChatWidgetProps } from "./PylonChatWidget";

/**
 * iOS implementation - simple passthrough.
 *
 * iOS uses native hitTest for touch pass-through, so no proxy logic needed.
 *
 * State Management:
 * - State lives entirely in native layer (no React state needed for iOS)
 * - Imperative methods call native, which handles everything
 * - Events are simply forwarded to user's listener
 */
export const PylonChatWidget = forwardRef<
  PylonChatViewRef,
  PylonChatWidgetProps
>(({ config, user, listener, style, topInset }, ref) => {
  // Internal ref - typed as any since iOS doesn't need clickElementAtSelector.
  const chatRef = useRef<PylonChatViewInternalRef>(null);

  // Forward ref methods - all state managed in native layer
  useImperativeHandle(ref, () => ({
    openChat: () => chatRef.current?.openChat(),
    closeChat: () => chatRef.current?.closeChat(),
    showChatBubble: () => chatRef.current?.showChatBubble(),
    hideChatBubble: () => chatRef.current?.hideChatBubble(),
    showNewMessage: (message: string, isHtml?: boolean) =>
      chatRef.current?.showNewMessage(message, isHtml),
    setNewIssueCustomFields: (fields: Record<string, any>) =>
      chatRef.current?.setNewIssueCustomFields(fields),
    setTicketFormFields: (fields: Record<string, any>) =>
      chatRef.current?.setTicketFormFields(fields),
    updateEmailHash: (emailHash: string | null) =>
      chatRef.current?.updateEmailHash(emailHash),
    showTicketForm: (slug: string) => chatRef.current?.showTicketForm(slug),
    showKnowledgeBaseArticle: (articleId: string) =>
      chatRef.current?.showKnowledgeBaseArticle(articleId),
  }));

  // Event handlers - forward to user's listener
  const handleChatOpened = useCallback(() => {
    listener?.onChatOpened?.();
  }, [listener]);

  const handleChatClosed = useCallback(
    (wasOpen: boolean) => {
      listener?.onChatClosed?.(wasOpen);
    },
    [listener]
  );

  return (
    <PylonChatView
      ref={chatRef}
      style={style || StyleSheet.absoluteFillObject}
      config={config}
      user={user}
      topInset={topInset}
      listener={{
        ...listener,
        onChatOpened: handleChatOpened,
        onChatClosed: handleChatClosed,
      }}
    />
  );
});

PylonChatWidget.displayName = "PylonChatWidget";

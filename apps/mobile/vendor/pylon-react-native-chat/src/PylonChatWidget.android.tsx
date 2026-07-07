import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type {
  PylonChatViewInternalRef,
  PylonChatViewRef,
} from "./PylonChatView";
import { PylonChatView } from "./PylonChatView";
import type { PylonChatWidgetProps } from "./PylonChatWidget";
import type { InteractiveBound } from "./types";

/**
 * Android implementation using proxy-based touch pass-through.
 *
 * State Management:
 * - isChatOpen is ONLY set by native events (onChatOpened/onChatClosed)
 * - Imperative methods (openChat/closeChat) call native, which then fires events
 * - This ensures state is always synced with native layer
 *
 * Touch Pass-Through Strategy:
 * 1. Native reports interactive element positions via onInteractiveBoundsChanged
 * 2. React renders clickable Pressable views at those positions
 * 3. When chat is closed: WebView has pointerEvents="none" (passes touches through)
 * 4. Touches hit background OR proxy
 * 5. Proxy clicked → calls openChat() → fires onChatOpened → state updates → WebView enabled
 */
export const PylonChatWidget = forwardRef<
  PylonChatViewRef,
  PylonChatWidgetProps
>(({ config, user, listener, style, topInset }, ref) => {
  // State synced ONLY via native events - single source of truth
  // TODO: Consider useSyncExternalStore for a more resilient solution in the future.
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [interactiveBounds, setInteractiveBounds] = useState<
    InteractiveBound[]
  >([]);

  // Internal ref has additional methods not exposed to SDK users.
  const chatRef = useRef<PylonChatViewInternalRef>(null);

  // Forward ref methods - these call native, which fires events that update state
  // CRITICAL: DO NOT set state directly here - let events handle it
  useImperativeHandle(ref, () => ({
    openChat: () => {
      chatRef.current?.openChat();
    },
    closeChat: () => {
      chatRef.current?.closeChat();
    },
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

  // CRITICAL: State is ONLY updated by these event handlers.
  // The flow is: imperative method → native JS call → Pylon widget event → native callback → React event.
  const handleChatOpened = useCallback(() => {
    setIsChatOpen(true);
    listener?.onChatOpened?.();
  }, [listener]);

  const handleChatClosed = useCallback(
    (wasOpen: boolean) => {
      setIsChatOpen(false);
      listener?.onChatClosed?.(wasOpen);
    },
    [listener]
  );

  const handleBoundsChanged = useCallback((bounds: InteractiveBound) => {
    setInteractiveBounds((prev) => {
      const existing = prev.findIndex((b) => b.selector === bounds.selector);

      // If bounds are 0,0,0,0 it means element is hidden - remove it
      const isHidden =
        bounds.left === 0 &&
        bounds.top === 0 &&
        bounds.right === 0 &&
        bounds.bottom === 0;

      if (existing >= 0) {
        const updated = [...prev];
        if (isHidden) {
          updated.splice(existing, 1);
        } else {
          updated[existing] = bounds;
        }
        return updated;
      }

      if (isHidden) {
        return prev;
      }

      return [...prev, bounds];
    });
  }, []);

  const handleProxyPress = useCallback((selector: string) => {
    // Trigger a click on the WebView element by its ID selector.
    // This kind of only works for areas with a single clickable element.
    // Really what htis needs to become is pass a coordinate to the webview, we look up whatever thing is at that
    // coordinate, and click it. Which is very sophisticated and hacky.
    chatRef.current?.clickElementAtSelector(selector);
  }, []);

  return (
    <>
      <View
        style={[StyleSheet.absoluteFill, style]}
        pointerEvents={isChatOpen ? "auto" : "none"}
      >
        {/* The actual WebView - disabled when chat is closed */}
        <PylonChatView
          ref={chatRef}
          style={StyleSheet.absoluteFillObject}
          config={config}
          user={user}
          topInset={topInset}
          listener={{
            ...listener,
            onChatOpened: handleChatOpened,
            onChatClosed: handleChatClosed,
            onInteractiveBoundsChanged: handleBoundsChanged,
          }}
        />
      </View>
      {!isChatOpen &&
        interactiveBounds.map((bounds, index) => (
          <Pressable
            key={`${bounds.selector}-${index}`}
            style={{
              position: "absolute",
              left: bounds.left,
              top: bounds.top,
              width: bounds.right - bounds.left,
              height: bounds.bottom - bounds.top,
              backgroundColor:
                __DEV__ && config.debugMode ? "rgba(0,255,0,0.2)" : undefined,
              borderWidth: __DEV__ && config.debugMode ? 2 : 0,
              borderColor: __DEV__ && config.debugMode ? "cyan" : undefined,
            }}
            onPress={() => handleProxyPress(bounds.selector)}
          />
        ))}
    </>
  );
});

PylonChatWidget.displayName = "PylonChatWidget";

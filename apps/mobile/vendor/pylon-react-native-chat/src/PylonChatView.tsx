import React, { useImperativeHandle, useRef } from "react";
import {
  findNodeHandle,
  Platform,
  UIManager,
  ViewStyle,
} from "react-native";
import RNPylonChatViewNativeComponent, {
  Commands,
} from "./specs/RNPylonChatViewNativeComponent";
import NativePylonChatCommands from "./NativePylonChatCommands";
import type { PylonChatListener, PylonConfig, PylonUser } from "./types";

export interface PylonChatViewRef {
  openChat: () => void;
  closeChat: () => void;
  showChatBubble: () => void;
  hideChatBubble: () => void;
  showNewMessage: (message: string, isHtml?: boolean) => void;
  setNewIssueCustomFields: (fields: Record<string, any>) => void;
  setTicketFormFields: (fields: Record<string, any>) => void;
  updateEmailHash: (emailHash: string | null) => void;
  showTicketForm: (slug: string) => void;
  showKnowledgeBaseArticle: (articleId: string) => void;
}

export interface PylonChatViewInternalRef extends PylonChatViewRef {
  clickElementAtSelector: (selector: string) => void;
}

interface PylonChatViewProps {
  config: PylonConfig;
  user?: PylonUser;
  style?: ViewStyle;
  listener?: PylonChatListener;
  topInset?: number;
}

export const PylonChatView = React.forwardRef<
  PylonChatViewInternalRef,
  PylonChatViewProps
>(({ config, user, style, listener, topInset = 0 }, ref) => {
  const nativeRef = useRef(null);

  const dispatchDictionaryCommand = (commandName: string, args: any[] = []) => {
    if (Platform.OS === "ios") {
      if (!NativePylonChatCommands) {
        console.error(
          `[PylonChat] NativePylonChatCommands module is null`,
        );
        return;
      }
      const fn = (NativePylonChatCommands as any)[commandName];
      if (fn) {
        fn(...args);
      } else {
        console.warn(
          `[PylonChat] RNPylonChatCommands.${commandName} not available`,
        );
      }
    } else {
      const handle = findNodeHandle(nativeRef.current);
      if (!handle) {
        return;
      }
      UIManager.dispatchViewManagerCommand(handle, commandName, args);
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      openChat: () => {
        if (nativeRef.current) {
          Commands.openChat(nativeRef.current);
        }
      },
      closeChat: () => {
        if (nativeRef.current) {
          Commands.closeChat(nativeRef.current);
        }
      },
      showChatBubble: () => {
        if (nativeRef.current) {
          Commands.showChatBubble(nativeRef.current);
        }
      },
      hideChatBubble: () => {
        if (nativeRef.current) {
          Commands.hideChatBubble(nativeRef.current);
        }
      },
      showNewMessage: (message: string, isHtml = false) => {
        if (nativeRef.current) {
          Commands.showNewMessage(nativeRef.current, message, isHtml);
        }
      },
      setNewIssueCustomFields: (fields: Record<string, any>) =>
        dispatchDictionaryCommand("setNewIssueCustomFields", [fields]),
      setTicketFormFields: (fields: Record<string, any>) =>
        dispatchDictionaryCommand("setTicketFormFields", [fields]),
      updateEmailHash: (emailHash: string | null) => {
        if (nativeRef.current) {
          Commands.updateEmailHash(nativeRef.current, emailHash ?? "");
        }
      },
      showTicketForm: (slug: string) => {
        if (nativeRef.current) {
          Commands.showTicketForm(nativeRef.current, slug);
        }
      },
      showKnowledgeBaseArticle: (articleId: string) => {
        if (nativeRef.current) {
          Commands.showKnowledgeBaseArticle(nativeRef.current, articleId);
        }
      },
      clickElementAtSelector: (selector: string) => {
        if (nativeRef.current) {
          Commands.clickElementAtSelector(nativeRef.current, selector);
        }
      },
    }),
    [],
  );

  return (
    <RNPylonChatViewNativeComponent
      ref={nativeRef}
      style={style}
      pointerEvents="box-none"
      appId={config.appId}
      widgetBaseUrl={config.widgetBaseUrl}
      widgetScriptUrl={config.widgetScriptUrl}
      enableLogging={config.enableLogging}
      debugMode={config.debugMode}
      primaryColor={config.primaryColor}
      userEmail={user?.email}
      userName={user?.name}
      userAvatarUrl={user?.avatarUrl}
      userEmailHash={user?.emailHash}
      userAccountId={user?.accountId}
      userAccountExternalId={user?.accountExternalId}
      topInset={topInset}
      onPylonLoaded={() => listener?.onPylonLoaded?.()}
      onPylonInitialized={() => listener?.onPylonInitialized?.()}
      onPylonReady={() => listener?.onPylonReady?.()}
      onChatOpened={() => listener?.onChatOpened?.()}
      onChatClosed={(event) =>
        listener?.onChatClosed?.(event.nativeEvent.wasOpen)
      }
      onUnreadCountChanged={(event) =>
        listener?.onUnreadCountChanged?.(event.nativeEvent.count)
      }
      onMessageReceived={(event) =>
        listener?.onMessageReceived?.(event.nativeEvent.message)
      }
      onPylonError={(event) =>
        listener?.onPylonError?.(event.nativeEvent.error)
      }
      onInteractiveBoundsChanged={(event) =>
        listener?.onInteractiveBoundsChanged?.(event.nativeEvent)
      }
    />
  );
});

PylonChatView.displayName = "PylonChatView";

export default PylonChatView;

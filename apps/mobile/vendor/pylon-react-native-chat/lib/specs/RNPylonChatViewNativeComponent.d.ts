import type { HostComponent, ViewProps } from 'react-native';
import type { DirectEventHandler, Double, Int32 } from 'react-native/Libraries/Types/CodegenTypes';
type OnChatClosedEvent = Readonly<{
    wasOpen: boolean;
}>;
type OnUnreadCountChangedEvent = Readonly<{
    count: Int32;
}>;
type OnMessageReceivedEvent = Readonly<{
    message: string;
}>;
type OnPylonErrorEvent = Readonly<{
    error: string;
}>;
type OnInteractiveBoundsChangedEvent = Readonly<{
    selector: string;
    left: Double;
    top: Double;
    right: Double;
    bottom: Double;
}>;
export interface NativeProps extends ViewProps {
    appId: string;
    widgetBaseUrl?: string;
    widgetScriptUrl?: string;
    enableLogging?: boolean;
    debugMode?: boolean;
    primaryColor?: string;
    userEmail?: string;
    userName?: string;
    userAvatarUrl?: string;
    userEmailHash?: string;
    userAccountId?: string;
    userAccountExternalId?: string;
    topInset?: Double;
    onPylonLoaded?: DirectEventHandler<null>;
    onPylonInitialized?: DirectEventHandler<null>;
    onPylonReady?: DirectEventHandler<null>;
    onChatOpened?: DirectEventHandler<null>;
    onChatClosed?: DirectEventHandler<OnChatClosedEvent>;
    onUnreadCountChanged?: DirectEventHandler<OnUnreadCountChangedEvent>;
    onMessageReceived?: DirectEventHandler<OnMessageReceivedEvent>;
    onPylonError?: DirectEventHandler<OnPylonErrorEvent>;
    onInteractiveBoundsChanged?: DirectEventHandler<OnInteractiveBoundsChangedEvent>;
}
type ComponentType = HostComponent<NativeProps>;
interface NativeCommands {
    openChat: (viewRef: React.ElementRef<ComponentType>) => void;
    closeChat: (viewRef: React.ElementRef<ComponentType>) => void;
    showChatBubble: (viewRef: React.ElementRef<ComponentType>) => void;
    hideChatBubble: (viewRef: React.ElementRef<ComponentType>) => void;
    showNewMessage: (viewRef: React.ElementRef<ComponentType>, message: string, isHtml: boolean) => void;
    updateEmailHash: (viewRef: React.ElementRef<ComponentType>, emailHash: string) => void;
    showTicketForm: (viewRef: React.ElementRef<ComponentType>, slug: string) => void;
    showKnowledgeBaseArticle: (viewRef: React.ElementRef<ComponentType>, articleId: string) => void;
    clickElementAtSelector: (viewRef: React.ElementRef<ComponentType>, selector: string) => void;
}
export declare const Commands: NativeCommands;
declare const _default: ComponentType;
export default _default;

import React from "react";
import { ViewStyle } from "react-native";
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
export declare const PylonChatView: React.ForwardRefExoticComponent<PylonChatViewProps & React.RefAttributes<PylonChatViewInternalRef>>;
export default PylonChatView;

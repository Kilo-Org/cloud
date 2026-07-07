import { NativeModules } from "react-native";

interface PylonChatCommands {
  openChat(): void;
  closeChat(): void;
  showChatBubble(): void;
  hideChatBubble(): void;
  showNewMessage(message: string, isHtml: boolean): void;
  setNewIssueCustomFields(fields: Object): void;
  setTicketFormFields(fields: Object): void;
  updateEmailHash(emailHash: string | null): void;
  showTicketForm(slug: string): void;
  showKnowledgeBaseArticle(articleId: string): void;
}

export default NativeModules.RNPylonChatCommands as PylonChatCommands;

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
declare const _default: PylonChatCommands;
export default _default;

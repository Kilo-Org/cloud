/**
 * Builds the event-service context path used to track "user is actively
 * viewing this conversation". Clients subscribe only while the conversation
 * is on screen and the app/tab is foregrounded.
 */
export const presenceContextForConversation = (conversationId: string): string =>
  `/presence/kiloclaw/chat/${conversationId}`;

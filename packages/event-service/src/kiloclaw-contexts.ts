/**
 * Event-context path builders for kiloclaw event subscriptions.
 *
 * These are the contexts on which kilo-chat publishes events (message
 * created, typing, etc.) and to which clients subscribe to receive
 * those events. Distinct from `/presence/*` contexts, which signal
 * whether the user is actively on a surface.
 */

export const kiloclawInstanceContext = (sandboxId: string) => `/kiloclaw/${sandboxId}` as const;

export const kiloclawConversationContext = (sandboxId: string, conversationId: string) =>
  `/kiloclaw/${sandboxId}/${conversationId}` as const;

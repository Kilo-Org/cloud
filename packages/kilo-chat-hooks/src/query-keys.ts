// Shared React Query key builders so subscribers (event handlers, mutations)
// invalidate exactly the keys the queries register under. Drift here silently
// breaks live updates — keep all kilo-chat keys in this file.

export const conversationsKey = (sandboxId: string | null) =>
  ['kilo-chat', 'conversations', sandboxId] as const;

export const conversationsKeyAll = () => ['kilo-chat', 'conversations'] as const;

export const conversationKey = (conversationId: string | null) =>
  ['kilo-chat', 'conversation', conversationId] as const;

export const messagesKey = (conversationId: string | null) =>
  ['kilo-chat', 'messages', conversationId] as const;

export const botStatusKey = (sandboxId: string | null) =>
  ['kilo-chat', 'bot-status', sandboxId] as const;

export const botStatusRequestKey = (sandboxId: string | null) =>
  ['kilo-chat', 'bot-status-request', sandboxId] as const;

/**
 * Presence-context path builders. These contexts live under /presence/*
 * and are subscribed by clients only when the user is *actively* on the
 * matching surface. The notifications pipeline queries them via
 * event-service.isUserInContext to skip pushes when the user is in-context.
 */

export type Platform = 'app' | 'web';

export const presenceContextForPlatform = (platform: Platform) => `/presence/${platform}` as const;

export const presenceContextForInstance = (sandboxId: string) =>
  `/presence/kiloclaw/${sandboxId}` as const;

export const presenceContextForConversation = (sandboxId: string, conversationId: string) =>
  `/presence/kiloclaw/${sandboxId}/${conversationId}` as const;

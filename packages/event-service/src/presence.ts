/**
 * Presence-context path builders. These contexts live under /presence/*
 * and are subscribed by clients only when the user is *actively* on the
 * matching surface. The notifications pipeline queries them via
 * event-service.isUserInContext to skip pushes when the user is in-context.
 *
 * The kiloclaw-scoped variants compose `/presence` with the corresponding
 * event-context paths so the segment shape is defined in exactly one place.
 */

import { kiloclawConversationContext, kiloclawInstanceContext } from './kiloclaw-contexts';

export type Platform = 'app' | 'web';

export const presenceContextForPlatform = (platform: Platform) => `/presence/${platform}` as const;

export const presenceContextForInstance = (sandboxId: string) =>
  `/presence${kiloclawInstanceContext(sandboxId)}` as const;

export const presenceContextForConversation = (sandboxId: string, conversationId: string) =>
  `/presence${kiloclawConversationContext(sandboxId, conversationId)}` as const;

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

/**
 * Exact-session presence context for Cloud Agent / remote CLI sessions.
 * Subscribed while the user is actively viewing the matching session, so
 * notifications routed through this context are suppressed only when the
 * user is on that specific session (not any other session). The
 * notifications pipeline queries it via event-service.isUserInContext.
 */
export const presenceContextForAgentSession = (cliSessionId: string) =>
  `/presence/agent-session/${cliSessionId}` as const;

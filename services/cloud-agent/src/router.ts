/**
 * tRPC Router - Main entry point
 *
 * This is a slim orchestrator that combines handler modules.
 * Handler implementations are in ./router/handlers/
 *
 * Note: Old websocket mutation handlers (websocket-mutations.ts) have been removed
 * in favor of V2 queue-based endpoints (session-queue-v2.ts) which use DO-managed
 * command queues for proper execution ordering.
 */
import { router } from './router/auth.js';
import { createSessionInitHandlers } from './router/handlers/session-init.js';
import { createSessionMessagingHandlers } from './router/handlers/session-messaging.js';
import { createSessionManagementHandlers } from './router/handlers/session-management.js';
import { createSessionPrepareHandlers } from './router/handlers/session-prepare.js';
import { createSessionQueueV2Handlers } from './router/handlers/session-queue.js';

export const appRouter = router({
  ...createSessionInitHandlers(),
  ...createSessionMessagingHandlers(),
  ...createSessionManagementHandlers(),
  ...createSessionPrepareHandlers(),
  ...createSessionQueueV2Handlers(),
});

export type AppRouter = typeof appRouter;

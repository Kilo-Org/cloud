import type { z } from 'zod';
import type { chatWebhookRpcSchema } from '@kilocode/kilo-chat';

// Augment the wrangler-generated Env with RPC method signatures for service
// bindings. `worker-configuration.d.ts` types these as plain Fetcher; this
// file layers on the RPC shape so call sites don't need runtime casts.
declare global {
  interface Env {
    KILOCLAW: Fetcher & {
      deliverChatWebhook(payload: z.infer<typeof chatWebhookRpcSchema>): Promise<void>;
    };
    EVENT_SERVICE: Fetcher & {
      pushEvent(userId: string, context: string, event: string, payload: unknown): Promise<void>;
      isUserInContext(userId: string, context: string): Promise<boolean>;
    };
  }
}

export {};

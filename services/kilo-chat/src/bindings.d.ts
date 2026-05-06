import type { z } from 'zod';
import type { chatWebhookRpcSchema, KiloChatEventName, KiloChatEventOf } from '@kilocode/kilo-chat';
import type {
  ClearBadgeBucketForUserInput,
  ClearBadgeBucketForUserOutput,
  SendPushForConversationInput,
  SendPushForConversationOutput,
} from '@kilocode/notifications';

// Augment the wrangler-generated Env with RPC method signatures for service
// bindings. `worker-configuration.d.ts` types these as plain Fetcher; this
// file layers on the RPC shape so call sites don't need runtime casts.
//
// The EVENT_SERVICE binding constrains `event` to `KiloChatEventName` here so
// that drift between kilo-chat emitters and the typed client's `on*`
// subscribers is a compile error. event-service itself stays generic
// (`<Name extends string>`) so other domains can reuse it with their own
// event-name unions.
declare global {
  interface Env {
    KILOCLAW: Fetcher & {
      deliverChatWebhook(payload: z.infer<typeof chatWebhookRpcSchema>): Promise<void>;
    };
    EVENT_SERVICE: Fetcher & {
      pushEvent<N extends KiloChatEventName>(
        userId: string,
        context: string,
        event: N,
        payload: KiloChatEventOf<N>
      ): Promise<boolean>;
    };
    NOTIFICATIONS: Fetcher & {
      sendPushForConversation(
        input: SendPushForConversationInput
      ): Promise<SendPushForConversationOutput>;
      clearBadgeBucketForUser(
        input: ClearBadgeBucketForUserInput
      ): Promise<ClearBadgeBucketForUserOutput>;
    };
  }
}

export {};

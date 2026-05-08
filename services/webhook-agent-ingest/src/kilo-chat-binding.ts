/**
 * RPC method types for the KILO_CHAT service binding.
 *
 * `wrangler types` generates a generic `Service` for service bindings; the
 * actual RPC shape comes from the kilo-chat worker's WorkerEntrypoint and is
 * declared here so the generated file can be regenerated freely.
 *
 * Keep in sync with: services/kilo-chat/src/services/post-message-as-user.ts
 * and services/kilo-chat/src/index.ts (KiloChatService).
 */

export type PostMessageAsUserCorrelation = {
  triggerId?: string;
  webhookRequestId?: string;
  reason?: string;
};

export type PostMessageAsUserParams = {
  userId: string;
  sandboxId: string;
  message: string;
  source: string;
  autoCreateConversation?: boolean;
  correlation?: PostMessageAsUserCorrelation;
};

export type PostMessageAsUserResult =
  | {
      ok: true;
      conversationId: string;
      messageId: string;
      conversationCreated: boolean;
    }
  | {
      ok: false;
      code: 'invalid_request' | 'no_conversation' | 'forbidden' | 'internal';
      error: string;
    };

export type KiloChatBinding = Fetcher & {
  postMessageAsUser(params: PostMessageAsUserParams): Promise<PostMessageAsUserResult>;
};

/**
 * Cast helper. wrangler types generates `Service` for the binding; the actual
 * RPC shape lives in this file. Centralizing the cast avoids scattering
 * `as unknown as KiloChatBinding` across call sites.
 */
export function getKiloChat(env: { KILO_CHAT: unknown }): KiloChatBinding {
  return env.KILO_CHAT as KiloChatBinding;
}

/**
 * RPC method types for the KILO_CHAT service binding.
 *
 * `wrangler types` only sees `Fetcher` for service bindings; the actual RPC
 * shape comes from the kilo-chat worker's WorkerEntrypoint and is declared
 * here so the generated file can be freely regenerated.
 *
 * Keep in sync with: services/kilo-chat/src/index.ts (KiloChatService).
 */

export type DestroySandboxDataResult = {
  ok: boolean;
  conversationsDeleted: number;
  failedConversations: string[];
};

export type KiloChatBinding = Fetcher & {
  destroySandboxData(sandboxId: string): Promise<DestroySandboxDataResult>;
};

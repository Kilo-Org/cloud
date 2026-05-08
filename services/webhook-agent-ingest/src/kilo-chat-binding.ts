/**
 * KILO_CHAT service-binding shape.
 *
 * The RPC contract types live in `@kilocode/kilo-chat` (rpc-types.ts) so
 * producer (services/kilo-chat) and consumers (this worker, others) share
 * one source of truth. wrangler-generated types only emit a generic
 * `Service` for service bindings, which is why we still need to declare
 * the local binding shape here and cast at the call site.
 */

import type { PostMessageAsUserParams, PostMessageAsUserResult } from '@kilocode/kilo-chat';

export type KiloChatBinding = Fetcher & {
  postMessageAsUser(params: PostMessageAsUserParams): Promise<PostMessageAsUserResult>;
};

/**
 * Cast helper. Centralizes the `as KiloChatBinding` cast so call sites
 * stay clean.
 */
export function getKiloChat(env: { KILO_CHAT: unknown }): KiloChatBinding {
  return env.KILO_CHAT as KiloChatBinding;
}

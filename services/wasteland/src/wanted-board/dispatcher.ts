/**
 * Routing seam between the libwl bridge (`wanted-board-ops.ts`) and
 * the `@kilocode/wl-sdk` adapter (`wanted-board-ops-sdk.ts`).
 *
 * The {@link useWlSdk} feature flag (`feature-flag.ts`) decides per
 * request which path runs. tRPC procedures call the `dispatch*`
 * functions instead of either backend directly, so adding a new flag
 * dimension later (per-user, gradual rollout) only touches this file.
 *
 * M3 will delete this module along with the libwl path; only the SDK
 * adapter will remain and tRPC will call it directly.
 */

import * as libwl from './wanted-board-ops';
import * as sdk from './wanted-board-ops-sdk';
import { useWlSdk } from './feature-flag';

export async function dispatchBrowse(
  env: Env,
  wastelandId: string,
  userId: string
): Promise<Array<Record<string, unknown>>> {
  return useWlSdk(env)
    ? sdk.browseWantedBoard(env, wastelandId, userId)
    : libwl.browseWantedBoard(env, wastelandId, userId);
}

export async function dispatchClaim(
  env: Env,
  wastelandId: string,
  userId: string,
  itemId: string,
  options?: { direct?: boolean }
): Promise<{ success: true; pr_url: string | null }> {
  return useWlSdk(env)
    ? sdk.claimWantedItem(env, wastelandId, userId, itemId, options)
    : libwl.claimWantedItem(env, wastelandId, userId, itemId, options);
}

export async function dispatchUnclaim(
  env: Env,
  wastelandId: string,
  userId: string,
  itemId: string,
  options?: { direct?: boolean }
): Promise<{ success: true }> {
  return useWlSdk(env)
    ? sdk.unclaimWantedItem(env, wastelandId, userId, itemId, options)
    : libwl.unclaimWantedItem(env, wastelandId, userId, itemId, options);
}

export async function dispatchPost(
  env: Env,
  wastelandId: string,
  userId: string,
  input: Parameters<typeof libwl.postWantedItem>[3]
): Promise<{ success: true }> {
  return useWlSdk(env)
    ? sdk.postWantedItem(env, wastelandId, userId, input)
    : libwl.postWantedItem(env, wastelandId, userId, input);
}

export async function dispatchMarkDone(
  env: Env,
  wastelandId: string,
  userId: string,
  input: Parameters<typeof libwl.markWantedItemDone>[3]
): Promise<{ success: true }> {
  return useWlSdk(env)
    ? sdk.markWantedItemDone(env, wastelandId, userId, input)
    : libwl.markWantedItemDone(env, wastelandId, userId, input);
}

export async function dispatchAccept(
  env: Env,
  wastelandId: string,
  userId: string,
  input: Parameters<typeof libwl.acceptWantedItem>[3]
): Promise<{ success: true }> {
  return useWlSdk(env)
    ? sdk.acceptWantedItem(env, wastelandId, userId, input)
    : libwl.acceptWantedItem(env, wastelandId, userId, input);
}

export async function dispatchReject(
  env: Env,
  wastelandId: string,
  userId: string,
  input: Parameters<typeof libwl.rejectWantedItem>[3]
): Promise<{ success: true }> {
  return useWlSdk(env)
    ? sdk.rejectWantedItem(env, wastelandId, userId, input)
    : libwl.rejectWantedItem(env, wastelandId, userId, input);
}

export async function dispatchClose(
  env: Env,
  wastelandId: string,
  userId: string,
  itemId: string,
  options?: { direct?: boolean }
): Promise<{ success: true }> {
  return useWlSdk(env)
    ? sdk.closeWantedItem(env, wastelandId, userId, itemId, options)
    : libwl.closeWantedItem(env, wastelandId, userId, itemId, options);
}

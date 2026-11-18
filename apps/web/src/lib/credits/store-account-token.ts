import { TRPCError } from '@trpc/server';

/**
 * Account-token assertions shared by the Kilo Pass store flow and the one-off
 * credit-pack store flow.
 *
 * A store purchase carries the account token the app attached at purchase time.
 * The backend only accepts it when it matches the signed-in user's
 * `app_store_account_token` (the same column both stores use). The messages are
 * shared verbatim so the mobile client maps either flow to the same copy.
 */

export const APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE =
  'App Store purchase account token does not match the signed-in user.';
export const APP_STORE_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE =
  "This App Store purchase isn't linked to your Kilo account. Make sure you're signed in to the Apple ID that made the purchase, then try again.";

export const GOOGLE_PLAY_ACCOUNT_TOKEN_MISMATCH_MESSAGE =
  'Google Play purchase account token does not match the signed-in user.';
export const GOOGLE_PLAY_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE =
  "This Google Play purchase isn't linked to your Kilo account. Make sure you're signed in to the Google account that made the purchase, then try again.";

type StoreAccountTokenAssertionParams = {
  appAccountToken: string | null;
  userAppStoreAccountToken: string;
  /**
   * Error code for a missing or mismatched token. Defaults to `BAD_REQUEST`,
   * which is the Kilo Pass behaviour; the credit-pack flow asks for `FORBIDDEN`.
   */
  code?: TRPCError['code'];
};

export function assertAppStoreAccountTokenMatchesUser(
  params: StoreAccountTokenAssertionParams
): void {
  if (params.appAccountToken === null) {
    throw new TRPCError({
      code: params.code ?? 'BAD_REQUEST',
      message: APP_STORE_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE,
    });
  }
  if (params.appAccountToken !== params.userAppStoreAccountToken) {
    throw new TRPCError({
      code: params.code ?? 'BAD_REQUEST',
      message: APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE,
    });
  }
}

export function assertGooglePlayAccountTokenMatchesUser(
  params: StoreAccountTokenAssertionParams
): void {
  if (params.appAccountToken === null) {
    throw new TRPCError({
      code: params.code ?? 'BAD_REQUEST',
      message: GOOGLE_PLAY_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE,
    });
  }
  if (params.appAccountToken !== params.userAppStoreAccountToken) {
    throw new TRPCError({
      code: params.code ?? 'BAD_REQUEST',
      message: GOOGLE_PLAY_ACCOUNT_TOKEN_MISMATCH_MESSAGE,
    });
  }
}

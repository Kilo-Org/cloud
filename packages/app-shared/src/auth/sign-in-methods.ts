/**
 * Stable wire codes for the sign-in method refusals.
 *
 * Unlinking a sign-in method is refused with `BAD_REQUEST` when it is the
 * account's only method, or when the row it names is already gone. The English
 * message each refusal carries is the web surface's copy; a device that has to
 * translate it cannot match on that sentence. The refusal's cause is an
 * `UpstreamApiError`, which the tRPC error formatter exposes to every client as
 * `data.upstreamCode`, so the mobile sign-in methods screen maps this code onto
 * catalog copy instead.
 */
export const SIGN_IN_METHOD_REFUSAL_CODES = {
  lastMethod: 'last_sign_in_method',
  // Another device, or the web page, unlinked this row first: the list the
  // reader sees is stale, so the screen reloads it after saying so.
  notLinked: 'sign_in_method_not_linked',
} as const;

export type SignInMethodRefusal = keyof typeof SIGN_IN_METHOD_REFUSAL_CODES;

export type SignInMethodRefusalCode = (typeof SIGN_IN_METHOD_REFUSAL_CODES)[SignInMethodRefusal];

// Derived by inverting SIGN_IN_METHOD_REFUSAL_CODES: a code added to that
// object is mapped here too, so it cannot resolve to null. A Map, not an
// object literal: an inherited `Object.prototype` name such as `constructor`
// must read as "no refusal", not as a function.
const REFUSAL_BY_CODE = new Map<string, SignInMethodRefusal>(
  Object.entries(SIGN_IN_METHOD_REFUSAL_CODES).map(
    ([refusal, code]): [string, SignInMethodRefusal] => [
      code,
      // Object.entries widens the const object's keys to `string`; its keys are
      // exactly the refusal names.
      refusal as SignInMethodRefusal,
    ]
  )
);

/** The sign-in method refusal an upstream code names, or null for any other code. */
export function signInMethodRefusalForCode(code: string | undefined): SignInMethodRefusal | null {
  if (code === undefined) {
    return null;
  }
  return REFUSAL_BY_CODE.get(code) ?? null;
}

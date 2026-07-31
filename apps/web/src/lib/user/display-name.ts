/**
 * Single-user display-name resolution, mirroring kilo-chat's
 * resolveUserDisplayInfo (services/kilo-chat/src/services/user-lookup.ts):
 * the most recent auth-provider row with a non-null display_name wins;
 * otherwise google_user_name; otherwise null.
 *
 * `providers` must be ordered by created_at ASC (getUserAuthProviders'
 * existing order). Empty strings pass through unchanged (kilo-chat parity);
 * the mobile greeting treats empty/whitespace as missing.
 */
export function resolveDisplayName(
  providers: ReadonlyArray<{ display_name: string | null }>,
  googleUserName: string | null
): string | null {
  const providerName = [...providers].reverse().find(p => p.display_name != null)?.display_name;
  return providerName ?? googleUserName ?? null;
}

/**
 * The stored organization selection.
 *
 * The selection is ONE SecureStore value under `ORGANIZATION_STORAGE_KEY`: an
 * organization id, or {@link PERSONAL_SELECTION} for an explicit Personal
 * choice. An absent value means "not chosen yet", which the organization
 * context's default rule resolves from the organization list.
 *
 * Readers decode through {@link decodeSelection}, so the Personal choice is
 * never mistaken for an organization id, and an account's selection travels as
 * one value that a save writes as a unit.
 */
export const PERSONAL_SELECTION = 'personal';

/** The selected organization id, or null for the Personal scope. */
export function decodeSelection(stored: string | null): string | null {
  return stored === PERSONAL_SELECTION ? null : stored;
}

/** The stored value that records `organizationId`, Personal included. */
export function encodeSelection(organizationId: string | null): string {
  return organizationId ?? PERSONAL_SELECTION;
}

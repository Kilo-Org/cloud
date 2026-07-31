/**
 * Normalize an organization ID so that `undefined` and empty strings never
 * cross the provider boundary. Returns `null` for falsy/empty values and
 * the original string otherwise.
 */
export const normalizeOrganizationId = (value: string | undefined): string | null => {
  if (value === undefined || value.trim() === '') {
    return null;
  }

  return value;
};

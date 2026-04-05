const regexCache = new Map<string, RegExp>();

function getRegex(pattern: string): RegExp {
  let regex = regexCache.get(pattern);
  if (!regex) {
    regex = new RegExp(pattern);
    regexCache.set(pattern, regex);
  }
  return regex;
}

/**
 * Validates a field value against its catalog validation pattern.
 *
 * Note: This function only validates the pattern format, not the maxLength.
 * Length enforcement happens at the input layer (zod schema in tRPC mutation,
 * HTML input maxLength in UI). This allows validateFieldValue to be used for
 * client-side format feedback without duplicating length checks.
 *
 * @param value - The value to validate (null/undefined = no validation needed)
 * @param pattern - Regex pattern string from catalog entry
 * @returns true if valid or no validation needed, false if invalid
 * @throws Error if the validation pattern is invalid (forces catalog authors to fix bad patterns)
 */
export function validateFieldValue(
  value: string | null | undefined,
  pattern: string | undefined
): boolean {
  // null/undefined = no validation needed (field not being set)
  if (value === null || value === undefined) {
    return true;
  }

  // Empty string is invalid
  if (value === '') {
    return false;
  }

  // No pattern = no validation
  if (!pattern) {
    return true;
  }

  try {
    return getRegex(pattern).test(value);
  } catch (err) {
    // Invalid regex pattern in catalog — throw to force fix during development
    throw new Error(
      `Invalid validation pattern in catalog: ${pattern}. ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

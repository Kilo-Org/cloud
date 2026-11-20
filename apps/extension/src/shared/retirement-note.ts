/**
 * The English retirement note the extension's model picker shows after a catalog
 * name (`' (retires Nov 20)'`), composed client-side from the gateway catalog's
 * `retires_on` field.
 *
 * Copied from `@kilocode/web-shared/lib/ai-gateway/providers/openrouter/retirement`:
 * the extension bundle does not depend on web-shared, and this is the one format
 * it reads. Keep the two in sync; the web-shared version is the source of truth.
 */

/**
 * The English suffix for a catalog entry's `retires_on` date (`yyyy-MM-dd`),
 * or `''` when the entry carries none.
 */
export function retirementNoteSuffix(retiresOn: string | undefined): string {
  if (retiresOn === undefined || retiresOn === '') {
    return '';
  }
  const date = new Date(retiresOn);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }
  const suffix = date.toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return ` (retires ${suffix})`;
}

/** A catalog entry's name with the English retirement note the picker shows. */
export function modelNameWithRetirement(model: {
  readonly name: string;
  readonly retires_on?: string;
}): string {
  return `${model.name}${retirementNoteSuffix(model.retires_on)}`;
}

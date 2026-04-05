/**
 * Docker/Fly image tag validation.
 * Must start with alphanumeric, then allow alphanumeric, dots, hyphens, underscores.
 */
export const IMAGE_TAG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const IMAGE_TAG_MAX_LENGTH = 128;

export function isValidImageTag(tag: string): boolean {
  return tag.length <= IMAGE_TAG_MAX_LENGTH && IMAGE_TAG_RE.test(tag);
}

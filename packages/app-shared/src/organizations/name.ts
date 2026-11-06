/**
 * The longest organization name the platform stores and accepts.
 *
 * Canonical here because more than one surface needs the number: the web
 * validator builds `OrganizationNameSchema` on it
 * (packages/web-shared/src/lib/organizations/organization-types.ts, a
 * `z.string()` whose `.max()` counts UTF-16 code units) and the mobile rename
 * dialog uses it as the text field's `maxLength`, which counts the same units. A dialog limit
 * below this one cuts a stored name as it opens, and the user has to edit the
 * cut text to save anything.
 */
export const ORGANIZATION_NAME_MAX_LENGTH = 100;

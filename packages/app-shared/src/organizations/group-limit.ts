/**
 * The most groups one organization can have. `organizations.groups.create`
 * counts the organization's groups and refuses the one that would pass this
 * number, and a client reads the same number to tell a reader the cap before
 * they fill in a form the server will reject.
 */
export const MAX_ORGANIZATION_GROUPS = 100;

/**
 * The server's rejection when the organization already holds
 * `MAX_ORGANIZATION_GROUPS` groups. Exported as one sentence so a client maps
 * it to its own localized copy instead of rendering the raw server text.
 *
 * `organizations.groups.create` throws it with `BAD_REQUEST`.
 */
export const ORGANIZATION_GROUP_LIMIT_MESSAGE = `An organization can have at most ${MAX_ORGANIZATION_GROUPS} groups.`;

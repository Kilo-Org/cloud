/**
 * Profiles one owner may hold: a user through `owned_by_user_id`, or an
 * organization through `owned_by_organization_id`.
 *
 * The `MAX_PROFILE_*` caps beside this one bound a single profile's
 * collections. This bounds how many profiles exist next to each other. It
 * applies to new profiles only: an owner already above it keeps every profile
 * it holds readable, editable, deletable and selectable as a default.
 */
export const MAX_OWNER_PROFILES = 100;

/**
 * Who runs the models an organization model list is offered for.
 *
 * - `member`: the viewing member runs them, as in a new cloud agent session.
 * - `shared_services`: a platform service runs them for the organization, as
 *   for code review, auto-triage, webhook triggers and the Discord
 *   bot. Such a run cannot use a member's own ChatGPT connection, so the list
 *   marks a model BYOK-available only for an organization BYOK key or the
 *   organization's shared-services ChatGPT connection.
 */
export const ORGANIZATION_MODEL_AUDIENCES = ['member', 'shared_services'] as const;
export type OrganizationModelAudience = (typeof ORGANIZATION_MODEL_AUDIENCES)[number];

/** Path of the organization model list endpoint for `audience`. */
export function organizationModelsPath(
  organizationId: string,
  audience: OrganizationModelAudience
): string {
  const path = `/api/organizations/${organizationId}/models`;
  return audience === 'member' ? path : `${path}?audience=${audience}`;
}

/**
 * Type definition for /api/sso/organizations endpoint
 *
 * Unified response format for all cases:
 * - SSO users: providers=['workos'], organizationId='org_xxx', newUser=false
 * - Multi-provider users: providers=['google','github'], newUser=false
 * - New users: providers=['google','github','email'], newUser=true
 */
export type SSOOrganizationsResponse = {
  providers: string[];
  organizationId?: string; // Only present for WorkOS/SSO users
  newUser: boolean;
};

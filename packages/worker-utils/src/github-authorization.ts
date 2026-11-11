import { z } from 'zod';

export const githubBrokerRejectionProvenanceSchema = z.enum([
  'managed_lookup_miss',
  'ambiguous_eligible_installations',
  'installation_token_http404',
]);
export type GitHubBrokerRejectionProvenance = z.infer<typeof githubBrokerRejectionProvenanceSchema>;

export const githubRepositoryAuthorizationFailureReasonSchema = z.enum([
  'database_not_configured',
  'invalid_repo_format',
  'no_installation_found',
  'repository_not_installed',
  'integration_mismatch',
  'invalid_org_id',
]);

export const githubRepositoryAuthorizationResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true) }),
  z.object({
    success: z.literal(false),
    reason: githubRepositoryAuthorizationFailureReasonSchema,
  }),
]);

export type GitHubRepositoryAuthorizationFailureReason = z.infer<
  typeof githubRepositoryAuthorizationFailureReasonSchema
>;

export type GitHubRepositoryAuthorizationResult = z.infer<
  typeof githubRepositoryAuthorizationResultSchema
>;

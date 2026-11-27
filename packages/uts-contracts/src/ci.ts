import { z } from 'zod';
import { UTS_ACCESS_TOKEN_TYPE_URN } from './exchange';
import { UtsScopeSchema } from './token';

/**
 * The CI token exchange at the UTS token endpoint (design 5.3, 5.5 and 6.2; RFC 8693). A GitHub
 * Actions job presents its OIDC token as the `subject_token` and receives one UTS access token for
 * the one account its trust policy names, with one scope from the policy's list, for at most one
 * hour. It replaces a long-lived Kilo API key stored as a repository secret. The token is not
 * refreshable: the job runs the exchange again with a fresh OIDC token.
 *
 * Request (`application/x-www-form-urlencoded`, no `Authorization` header and no `client_id`):
 * `grant_type` is the RFC 8693 grant, `subject_token` the job's OIDC token, whose `aud` is the UTS
 * issuer URL of the environment, `subject_token_type` is `UTS_ID_TOKEN_TYPE_URN`, and exactly one
 * `scope` and one `resource` (RFC 8707: `urn:kilo:service:<audience>` or the audience's listed
 * origin). `requested_token_type` is optional and, when sent, the access-token type.
 */

/** RFC 8693 section 3: the token type of an OpenID Connect ID token, such as a GitHub OIDC token. */
export const UTS_ID_TOKEN_TYPE_URN = 'urn:ietf:params:oauth:token-type:id_token';

/** The issuer of GitHub Actions OIDC tokens on github.com. */
export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

/** Design 5.3: a CI token lives at most 1 hour; each trust policy sets its own lifetime up to it. */
export const UTS_CI_TOKEN_MAX_LIFETIME_SECONDS = 3600;

/** The success answer (RFC 8693 section 2.2.1). No refresh token is issued. */
export const CiTokenResponseSchema = z.strictObject({
  access_token: z.string().min(1),
  issued_token_type: z.literal(UTS_ACCESS_TOKEN_TYPE_URN),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive().max(UTS_CI_TOKEN_MAX_LIFETIME_SECONDS),
  scope: UtsScopeSchema,
});
export type CiTokenResponse = z.infer<typeof CiTokenResponseSchema>;

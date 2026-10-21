import { z } from 'zod';
import { CLOUD_AGENT_NEXT_AUDIENCE, KILO_API_AUDIENCE } from './internal-service-token-audiences';

export const PARENT_SESSION_CALLBACK_URL = 'session:parent';
export const ParentSessionCallbackTargetSchema = z
  .object({ url: z.literal(PARENT_SESSION_CALLBACK_URL) })
  .strict()
  .describe('Notify the spawning parent session when this child finishes. Omit for no callback.');

export const CloudAgentSpawnProcedureSchema = z.enum([
  'cloudAgentNext.prepareSession',
  'organizations.cloudAgentNext.prepareSession',
]);

export const CloudAgentAuthoritySchema = z
  .object({
    version: z.literal(1),
    ownerId: z.string().min(1),
    parentSessionId: z.string().min(1),
    organizationId: z.string().min(1).nullable(),
    authorizationId: z.uuid(),
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type CloudAgentAuthority = z.infer<typeof CloudAgentAuthoritySchema>;

const numericDate = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scopedTokenClaimsSchema = z
  .object({
    version: z.literal(3),
    kiloUserId: z.string().min(1),
    apiTokenPepper: z.string().nullable(),
    env: z.string().optional(),
    aud: z.union([
      z.enum([KILO_API_AUDIENCE, CLOUD_AGENT_NEXT_AUDIENCE]),
      z.array(z.enum([KILO_API_AUDIENCE, CLOUD_AGENT_NEXT_AUDIENCE])).length(1),
    ]),
    iat: numericDate,
    exp: numericDate,
    tokenPurpose: z.literal('delegated-workload'),
    credentialExchange: z.literal(false),
    organizationId: z.string().min(1).optional(),
    tokenSource: z.string().optional(),
    cloudAgentAuthority: CloudAgentAuthoritySchema,
  })
  .strict()
  .superRefine((claims, ctx) => {
    if (
      claims.cloudAgentAuthority.ownerId !== claims.kiloUserId ||
      claims.cloudAgentAuthority.organizationId !== (claims.organizationId ?? null) ||
      claims.exp !== claims.cloudAgentAuthority.expiresAt ||
      claims.exp <= claims.iat
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid Cloud Agent authority token binding' });
    }
  });

export function validateCloudAgentAuthorityClaims(claims: unknown): CloudAgentAuthority {
  return scopedTokenClaimsSchema.parse(claims).cloudAgentAuthority;
}

const scopedPrepareSessionSchema = z
  .object({
    githubRepo: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
    model: z.string().min(1).max(200),
    mode: z.enum(['code', 'plan', 'debug', 'orchestrator', 'ask', 'build', 'architect']),
    prompt: z.string().min(1).max(100_000),
    variant: z
      .string()
      .max(50)
      .regex(/^[a-zA-Z]+$/)
      .optional(),
    upstreamBranch: z.string().min(1).max(500).optional(),
    autoCommit: z.boolean().optional(),
    autoInitiate: z.literal(true),
    operationKey: z.uuid().optional(),
    allowSubagentSessions: z.boolean().optional(),
    callbackTarget: ParentSessionCallbackTargetSchema.optional(),
    organizationId: z.string().min(1).optional(),
  })
  .strict();

export function cloudAgentAuthorityInputSchema(
  authority: CloudAgentAuthority
): Record<string, unknown> {
  return z.toJSONSchema(
    scopedPrepareSessionSchema.extend({
      organizationId:
        authority.organizationId === null
          ? z.never().optional()
          : z.literal(authority.organizationId),
    })
  );
}

export function cloudAgentAuthorityProcedure(authority: CloudAgentAuthority) {
  return authority.organizationId === null
    ? 'cloudAgentNext.prepareSession'
    : 'organizations.cloudAgentNext.prepareSession';
}

export function validateCloudAgentAuthorityRequest(
  authority: unknown,
  procedure: string,
  input: unknown,
  nowSeconds = Math.floor(Date.now() / 1000)
): z.infer<typeof scopedPrepareSessionSchema> {
  const scope = CloudAgentAuthoritySchema.parse(authority);
  const parsedProcedure = CloudAgentSpawnProcedureSchema.parse(procedure);
  if (scope.expiresAt <= nowSeconds || cloudAgentAuthorityProcedure(scope) !== parsedProcedure) {
    throw new Error('Cloud Agent authority does not permit this procedure');
  }
  const request = scopedPrepareSessionSchema.parse(input);
  const organizationProcedure = parsedProcedure === 'organizations.cloudAgentNext.prepareSession';
  if (
    organizationProcedure !== (scope.organizationId !== null) ||
    (request.organizationId ?? null) !== scope.organizationId
  ) {
    throw new Error('Cloud Agent launch exceeds its authority');
  }
  return request;
}

export function isCloudAgentAuthorityHttpPathAllowed(
  authority: CloudAgentAuthority,
  pathname: string | undefined
): boolean {
  if (authority.expiresAt <= Math.floor(Date.now() / 1000)) return false;
  if (pathname === '/api/user') return true;
  if (!pathname?.startsWith('/api/trpc/')) return false;
  const paths = pathname.slice('/api/trpc/'.length).split(',');
  return paths.length > 0 && paths.every(path => cloudAgentAuthorityProcedure(authority) === path);
}

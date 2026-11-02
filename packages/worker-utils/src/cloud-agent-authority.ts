import { z } from 'zod';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
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
    callbackTarget: ParentSessionCallbackTargetSchema.optional(),
    organizationId: z.string().min(1).optional(),
  })
  .strict();

const childSessionIdSchema = z.templateLiteral(['workspace_', z.uuid()]);
const childMessageIdSchema = z.string().regex(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
const scopedChildOperations = {
  prepareSession: { kind: 'mutation', schema: scopedPrepareSessionSchema },
  listChildSessions: {
    kind: 'query',
    schema: z
      .object({ limit: z.number().int().min(1).max(50).default(20), cursor: z.uuid().optional() })
      .strict(),
  },
  getSession: {
    kind: 'query',
    schema: z.object({ cloudAgentSessionId: childSessionIdSchema }).strict(),
  },
  getMessageResult: {
    kind: 'query',
    schema: z
      .object({
        cloudAgentSessionId: childSessionIdSchema,
        messageId: childMessageIdSchema,
        expectedWorktreeId: cloudAgentWorktreeIdSchema.optional(),
      })
      .strict(),
  },
  interruptSession: {
    kind: 'mutation',
    schema: z.object({ sessionId: childSessionIdSchema }).strict(),
  },
  sendMessage: {
    kind: 'mutation',
    schema: z
      .object({
        cloudAgentSessionId: childSessionIdSchema,
        messageId: childMessageIdSchema,
        payload: z
          .object({
            type: z.literal('prompt'),
            prompt: z
              .string()
              .min(1)
              .max(100_000)
              .refine(prompt => prompt.trim().length > 0),
            mode: scopedPrepareSessionSchema.shape.mode,
            model: scopedPrepareSessionSchema.shape.model,
            variant: scopedPrepareSessionSchema.shape.variant,
          })
          .strict(),
        autoCommit: z.boolean().optional(),
        expectedWorktreeId: cloudAgentWorktreeIdSchema.optional(),
      })
      .strict(),
  },
} as const;

function childOperation(procedure: string) {
  const match = /^(?:organizations\.)?cloudAgentNext\.([A-Za-z]+)$/.exec(procedure);
  const name = match?.[1];
  if (!name || !Object.hasOwn(scopedChildOperations, name)) {
    throw new Error('Cloud Agent authority does not permit this procedure');
  }
  return scopedChildOperations[name as keyof typeof scopedChildOperations];
}

export function cloudAgentAuthorityProcedures(authority: CloudAgentAuthority): string[] {
  const prefix =
    authority.organizationId === null ? 'cloudAgentNext' : 'organizations.cloudAgentNext';
  return Object.keys(scopedChildOperations).map(name => `${prefix}.${name}`);
}

export function cloudAgentAuthorityProcedureKind(procedure: string): 'query' | 'mutation' {
  return childOperation(procedure).kind;
}

export function cloudAgentAuthorityInputSchema(
  authority: CloudAgentAuthority,
  procedure = cloudAgentAuthorityProcedure(authority)
): Record<string, unknown> {
  if (!cloudAgentAuthorityProcedures(authority).includes(procedure)) {
    throw new Error('Cloud Agent launch exceeds its authority');
  }
  return z.toJSONSchema(
    childOperation(procedure).schema.extend({
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
) {
  const scope = CloudAgentAuthoritySchema.parse(authority);
  if (scope.expiresAt <= nowSeconds || !cloudAgentAuthorityProcedures(scope).includes(procedure)) {
    throw new Error('Cloud Agent authority does not permit this procedure');
  }
  const operation = childOperation(procedure);
  const request = operation.schema
    .extend({ organizationId: z.string().min(1).optional() })
    .parse(input);
  const organizationProcedure = procedure.startsWith('organizations.');
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
  const allowed = cloudAgentAuthorityProcedures(authority);
  return paths.length > 0 && paths.every(path => allowed.includes(path));
}

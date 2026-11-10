import { z } from 'zod';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { CLOUD_AGENT_NEXT_AUDIENCE, KILO_API_AUDIENCE } from './internal-service-token-audiences';

export const PARENT_WORKSPACE_CALLBACK_URL = 'workspace:new-chat';
export const WORKSPACE_SESSION_CALLBACK_PREFIX = 'workspace:';
const WORKSPACE_SESSION_CALLBACK_URL_PATTERN =
  /^workspace:workspace_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ParentWorkspaceCallbackTargetSchema = z
  .object({ url: z.literal(PARENT_WORKSPACE_CALLBACK_URL) })
  .strict()
  .describe(
    'Open a new chat in the spawning parent workspace and use this child result as its first message. Omit for no callback.'
  );
export const ParentWorkspaceSessionCallbackTargetSchema = z
  .object({
    url: z.string().regex(WORKSPACE_SESSION_CALLBACK_URL_PATTERN),
  })
  .strict()
  .describe(
    'Notify one existing chat in the spawning parent workspace. Use the workspace session id from the cloud-agent-context in your messages.'
  );
export const ParentCallbackTargetSchema = z
  .union([ParentWorkspaceCallbackTargetSchema, ParentWorkspaceSessionCallbackTargetSchema])
  .describe(
    'Open a new chat in the spawning parent workspace, or notify one existing chat in that workspace. Omit for no callback.'
  );

export type ParentWorkspaceSessionCallbackTarget = z.infer<
  typeof ParentWorkspaceSessionCallbackTargetSchema
>;

export function parseWorkspaceSessionCallbackTarget(url: string): string | null {
  if (!WORKSPACE_SESSION_CALLBACK_URL_PATTERN.test(url)) return null;
  return url.slice(WORKSPACE_SESSION_CALLBACK_PREFIX.length);
}

export function isWorkspaceCallbackTargetUrl(url: string): boolean {
  return url === PARENT_WORKSPACE_CALLBACK_URL || parseWorkspaceSessionCallbackTarget(url) !== null;
}

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

const requestedEnvironmentSchema = z
  .object({
    id: z.uuid(),
    repositories: z
      .array(
        z
          .object({
            repoFullName: z.string().min(1).max(500),
            branch: z.string().min(1).max(255).optional(),
          })
          .strict()
      )
      .max(100)
      .optional(),
  })
  .strict();

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
    stackOnWorktreeId: cloudAgentWorktreeIdSchema
      .describe(
        "Stack on a direct child's pushed worktree in the same repository. Use the worktreeId from spawn_session or list_child_sessions. Omit upstreamBranch."
      )
      .optional(),
    autoCommit: z.boolean().optional(),
    autoInitiate: z.literal(true),
    operationKey: z
      .uuid()
      .optional()
      .describe('Use a fresh UUID for each child workspace. Reuse it only for the same launch.'),
    callbackTarget: ParentCallbackTargetSchema.optional(),
    requestedEnvironment: requestedEnvironmentSchema.optional(),
  })
  .strict()
  // Callers add organizationId with extend(). Zod refuses to overwrite a key on a
  // refined object, so the base shape must not declare it.
  .refine(input => input.stackOnWorktreeId === undefined || input.upstreamBranch === undefined, {
    message: 'A stacked workspace cannot use an upstream branch',
    path: ['upstreamBranch'],
  });

const childSessionIdSchema = z.templateLiteral(['workspace_', z.uuid()]);
const childMessageIdSchema = z.string().regex(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
// Discovery is scope-neutral; auth context pins any signed organization, and the
// shared input stays empty so it cannot carry one.
const MODELS_LIST_PROCEDURE = 'models.list';
const modelsListInputSchema = z.object({}).strict();
// The environment catalog route is shared by personal and organization scope
// (there is no organizations.* mirror), so authority binding is enforced here.
const CLOUD_ENVIRONMENTS_LIST_PROCEDURE = 'cloudEnvironments.list';
const cloudEnvironmentRepositorySchema = z
  .object({ platform: z.literal('github'), fullName: z.string().min(1).max(500) })
  .strict();
const cloudEnvironmentsListInputSchema = z
  .object({ repository: cloudEnvironmentRepositorySchema })
  .strict();
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

const scopedFolderOperations = {
  'workspaceFolders.list': { kind: 'query', schema: z.object({}).strict() },
  'workspaceFolders.moveWorktree': {
    kind: 'mutation',
    schema: z
      .object({
        cloudAgentSessionId: childSessionIdSchema,
        worktreeId: cloudAgentWorktreeIdSchema,
        folderId: z.uuid().nullable(),
      })
      .strict(),
  },
} as const;

function scopedOperation(procedure: string) {
  if (Object.hasOwn(scopedFolderOperations, procedure)) {
    return scopedFolderOperations[procedure as keyof typeof scopedFolderOperations];
  }
  const match = /^(?:organizations\.)?cloudAgentNext\.([A-Za-z]+)$/.exec(procedure);
  const name = match?.[1];
  if (!name || !Object.hasOwn(scopedChildOperations, name)) {
    throw new Error('Cloud Agent authority does not permit this procedure');
  }
  return scopedChildOperations[name as keyof typeof scopedChildOperations];
}

function isModelsListProcedure(procedure: string): boolean {
  return procedure === MODELS_LIST_PROCEDURE;
}

function isCloudEnvironmentsListProcedure(procedure: string): boolean {
  return procedure === CLOUD_ENVIRONMENTS_LIST_PROCEDURE;
}

export function cloudAgentAuthorityProcedures(authority: CloudAgentAuthority): string[] {
  const prefix =
    authority.organizationId === null ? 'cloudAgentNext' : 'organizations.cloudAgentNext';
  return [
    ...Object.keys(scopedChildOperations).map(name => `${prefix}.${name}`),
    MODELS_LIST_PROCEDURE,
    CLOUD_ENVIRONMENTS_LIST_PROCEDURE,
    ...Object.keys(scopedFolderOperations),
  ];
}

export function cloudAgentAuthorityProcedureKind(procedure: string): 'query' | 'mutation' {
  if (isModelsListProcedure(procedure) || isCloudEnvironmentsListProcedure(procedure)) {
    return 'query';
  }
  return scopedOperation(procedure).kind;
}

export function cloudAgentAuthorityInputSchema(
  authority: CloudAgentAuthority,
  procedure = cloudAgentAuthorityProcedure(authority)
): Record<string, unknown> {
  if (!cloudAgentAuthorityProcedures(authority).includes(procedure)) {
    throw new Error('Cloud Agent launch exceeds its authority');
  }
  if (isModelsListProcedure(procedure)) {
    return z.toJSONSchema(modelsListInputSchema, { io: 'input' });
  }
  if (isCloudEnvironmentsListProcedure(procedure)) {
    return z.toJSONSchema(
      cloudEnvironmentsListInputSchema.extend({
        organizationId:
          authority.organizationId === null
            ? z.never().optional()
            : z.literal(authority.organizationId),
      }),
      { io: 'input' }
    );
  }
  return z.toJSONSchema(
    scopedOperation(procedure).schema.extend({
      organizationId: procedure.startsWith('workspaceFolders.')
        ? z.literal(authority.organizationId)
        : authority.organizationId === null
          ? z.never().optional()
          : z.literal(authority.organizationId),
    }),
    { io: 'input' }
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
  if (isModelsListProcedure(procedure)) {
    return modelsListInputSchema.optional().parse(input);
  }
  if (isCloudEnvironmentsListProcedure(procedure)) {
    const request = cloudEnvironmentsListInputSchema
      .extend({
        organizationId:
          scope.organizationId === null ? z.never().optional() : z.string().min(1).optional(),
      })
      .parse(input);
    if ((request.organizationId ?? null) !== scope.organizationId) {
      throw new Error('Cloud Agent launch exceeds its authority');
    }
    return request;
  }
  const operation = scopedOperation(procedure);
  const folderProcedure = procedure.startsWith('workspaceFolders.');
  const request = operation.schema
    .extend({
      organizationId: folderProcedure
        ? z.literal(scope.organizationId)
        : z.string().min(1).optional(),
    })
    .parse(input);
  const organizationProcedure = procedure.startsWith('organizations.');
  if (
    (!folderProcedure && organizationProcedure !== (scope.organizationId !== null)) ||
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

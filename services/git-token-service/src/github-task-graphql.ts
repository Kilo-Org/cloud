import { githubTaskGraphqlShapes as shapes } from './github-task-graphql-shapes.js';
import {
  Kind,
  OperationTypeNode,
  parse,
  valueFromASTUntyped,
  type ArgumentNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from 'graphql';
import { z } from 'zod';
import {
  allowGitHubTaskRequest as allow,
  allowGitHubTaskRead,
  denyGitHubTaskRequest as deny,
  type GitHubTaskCheck,
  type GitHubTaskDecision,
  type GitHubTaskGrant,
} from '@kilocode/worker-utils/github-task-grant';

const requestSchema = z
  .object({
    query: z.string().min(1).max(65_536),
    variables: z.record(z.string(), z.unknown()).nullable().optional(),
    operationName: z.string().min(1).nullable().optional(),
  })
  .strict();

const createSchema = z
  .object({
    repositoryId: z.string(),
    headRefName: z.string(),
    baseRefName: z.string().min(1),
    title: z.string().min(1).max(1024),
    body: z.string().max(65_536).optional(),
    draft: z.boolean().optional(),
    maintainerCanModify: z.boolean().optional(),
    clientMutationId: z.string().max(256).optional(),
  })
  .strict();
const updateSchema = z
  .object({
    pullRequestId: z.string().min(1),
    title: z.string().min(1).max(1024).optional(),
    body: z.string().max(65_536).optional(),
    baseRefName: z.string().min(1).optional(),
    state: z.enum(['OPEN', 'CLOSED']).optional(),
    maintainerCanModify: z.boolean().optional(),
    clientMutationId: z.string().max(256).optional(),
  })
  .strict();
const pullActionSchema = z
  .object({ pullRequestId: z.string().min(1), clientMutationId: z.string().max(256).optional() })
  .strict();
const commentSchema = z
  .object({
    subjectId: z.string().min(1),
    body: z.string().min(1).max(65_536),
    clientMutationId: z.string().max(256).optional(),
  })
  .strict();
const reviewSchema = z
  .object({
    pullRequestId: z.string().min(1),
    event: z.enum(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']),
    body: z.string().max(65_536).optional(),
    commitOID: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    threads: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            body: z.string().min(1).max(65_536),
            line: z.number().int().positive().optional(),
            side: z.enum(['LEFT', 'RIGHT']).optional(),
            startLine: z.number().int().positive().optional(),
            startSide: z.enum(['LEFT', 'RIGHT']).optional(),
            subjectType: z.enum(['LINE', 'FILE']).optional(),
          })
          .strict()
      )
      .max(100)
      .optional(),
    clientMutationId: z.string().max(256).optional(),
  })
  .strict();

const issueFields = {
  title: z.string().min(1).max(1024),
  body: z.string().max(65_536).optional(),
  assigneeIds: z.array(z.string().min(1)).max(100).optional(),
  labelIds: z.array(z.string().min(1)).max(100).optional(),
  milestoneId: z.string().min(1).nullable().optional(),
  clientMutationId: z.string().max(256).optional(),
};
const createIssueSchema = z.object({ repositoryId: z.string().min(1), ...issueFields }).strict();
const updateIssueSchema = z
  .object({
    id: z.string().min(1),
    ...issueFields,
    title: issueFields.title.optional(),
    state: z.enum(['OPEN', 'CLOSED']).optional(),
  })
  .strict();
const issueActionSchema = z
  .object({
    issueId: z.string().min(1),
    stateReason: z.enum(['COMPLETED', 'NOT_PLANNED']).optional(),
    clientMutationId: z.string().max(256).optional(),
  })
  .strict();

function authorizeMutation(
  name: string,
  input: unknown,
  grant: GitHubTaskGrant
): GitHubTaskDecision {
  if (name === 'createPullRequest') {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) return deny('invalid_upstream_request');
    if (parsed.data.repositoryId !== grant.repository.nodeId) return deny('repository_mismatch');
    return allow();
  }
  if (name === 'createIssue') {
    const parsed = createIssueSchema.safeParse(input);
    if (!parsed.success) return deny('invalid_upstream_request');
    return parsed.data.repositoryId === grant.repository.nodeId
      ? allow()
      : deny('repository_mismatch');
  }
  if (name === 'updateIssue') {
    const parsed = updateIssueSchema.safeParse(input);
    return parsed.success
      ? allow([{ kind: 'repository-issue-node', nodeId: parsed.data.id }])
      : deny('invalid_upstream_request');
  }
  if (name === 'closeIssue' || name === 'reopenIssue') {
    const parsed = issueActionSchema.safeParse(input);
    return parsed.success
      ? allow([{ kind: 'repository-issue-node', nodeId: parsed.data.issueId }])
      : deny('invalid_upstream_request');
  }
  if (name === 'addComment') {
    const parsed = commentSchema.safeParse(input);
    return parsed.success
      ? allow([{ kind: 'repository-subject-node', nodeId: parsed.data.subjectId }])
      : deny('invalid_upstream_request');
  }
  if (name === 'addPullRequestReview') {
    const parsed = reviewSchema.safeParse(input);
    return parsed.success
      ? allow([{ kind: 'repository-pull-request-node', nodeId: parsed.data.pullRequestId }])
      : deny('invalid_upstream_request');
  }
  const parsed = (name === 'updatePullRequest' ? updateSchema : pullActionSchema).safeParse(input);
  return parsed.success
    ? allow([{ kind: 'repository-pull-request-node', nodeId: parsed.data.pullRequestId }])
    : deny('invalid_upstream_request');
}

export function authorizeGitHubTaskGraphql(
  body: unknown,
  grant: GitHubTaskGrant
): GitHubTaskDecision {
  const request = requestSchema.safeParse(body);
  if (!request.success) return deny('invalid_upstream_request');
  try {
    const document = parse(request.data.query, { maxTokens: 4096 });
    const operations = document.definitions.filter(
      definition => definition.kind === Kind.OPERATION_DEFINITION
    );
    if (operations.length !== 1) return deny('operation_not_allowed');
    const operation = operations[0];
    if (
      operation.operation === OperationTypeNode.SUBSCRIPTION ||
      (request.data.operationName && request.data.operationName !== operation.name?.value)
    )
      return deny('operation_not_allowed');
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const definition of document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        if (fragments.has(definition.name.value)) return deny('invalid_upstream_request');
        fragments.set(definition.name.value, definition);
      } else if (definition.kind !== Kind.OPERATION_DEFINITION)
        return deny('invalid_upstream_request');
    }
    const variables: Record<string, unknown> = { __proto__: null };
    const declared = new Set<string>();
    for (const definition of operation.variableDefinitions ?? []) {
      const name = definition.variable.name.value;
      if (declared.has(name)) return deny('invalid_upstream_request');
      declared.add(name);
      variables[name] = Object.hasOwn(request.data.variables ?? {}, name)
        ? request.data.variables?.[name]
        : definition.defaultValue
          ? valueFromASTUntyped(definition.defaultValue)
          : undefined;
    }
    const readValue = (node: ValueNode): unknown => {
      if (node.kind === Kind.VARIABLE && !declared.has(node.name.value))
        throw new Error('undeclared variable');
      if (node.kind === Kind.OBJECT) {
        const names = node.fields.map(field => field.name.value);
        if (new Set(names).size !== names.length) throw new Error('duplicate input field');
        for (const field of node.fields) readValue(field.value);
      }
      if (node.kind === Kind.LIST) for (const value of node.values) readValue(value);
      return valueFromASTUntyped(node, variables);
    };
    const readArguments = (
      nodes: readonly ArgumentNode[],
      allowed: string[]
    ): Record<string, unknown> => {
      const values: Record<string, unknown> = { __proto__: null };
      for (const node of nodes) {
        if (!allowed.includes(node.name.value) || Object.hasOwn(values, node.name.value))
          throw new Error('unsupported argument');
        const value = readValue(node.value);
        if (
          ['first', 'last'].includes(node.name.value) &&
          (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100)
        )
          throw new Error('pagination limit');
        values[node.name.value] = value;
      }
      return values;
    };
    let fields = 0;
    let mutations = 0;
    const checks: GitHubTaskCheck[] = [];
    const inspect = (
      selection: SelectionSetNode,
      shapeName: string,
      depth: number
    ): GitHubTaskDecision => {
      if (depth > 16) return deny('invalid_upstream_request');
      const shape = shapes[shapeName];
      if (!shape) return deny('operation_not_allowed');
      for (const node of selection.selections) {
        if (++fields > 256) return deny('invalid_upstream_request');
        for (const directive of node.directives ?? []) {
          if (
            !['skip', 'include'].includes(directive.name.value) ||
            typeof readArguments(directive.arguments ?? [], ['if']).if !== 'boolean'
          )
            return deny('operation_not_allowed');
        }
        if (node.kind !== Kind.FIELD) {
          const fragment =
            node.kind === Kind.FRAGMENT_SPREAD ? fragments.get(node.name.value) : node;
          if (!fragment) return deny('invalid_upstream_request');
          const condition = fragment.typeCondition?.name.value;
          if (condition && !shape.types.includes(condition)) return deny('operation_not_allowed');
          const narrowed =
            shapeName === 'pullOrIssue'
              ? condition === 'PullRequest'
                ? 'pull'
                : condition === 'Issue'
                  ? 'issue'
                  : shapeName
              : shapeName;
          const decision = inspect(fragment.selectionSet, narrowed, depth + 1);
          if (!decision.allowed) return decision;
          continue;
        }
        const name = node.name.value;
        const args = readArguments(node.arguments ?? [], shape.arguments?.[name] ?? []);
        if (shapeName === 'projectItem' && name === 'fieldValueByName' && args.name !== 'Status')
          return deny('operation_not_allowed');
        if (shapeName === 'query' && name === 'repository') {
          if (
            typeof args.owner !== 'string' ||
            typeof args.name !== 'string' ||
            !/^[a-z0-9_.-]+$/i.test(args.owner) ||
            !/^[a-z0-9_.-]+$/i.test(args.name)
          )
            return deny('repository_mismatch');
          if (args.followRenames === true) return deny('operation_not_allowed');
          if (
            args.owner.toLowerCase() !== grant.repository.owner ||
            args.name.toLowerCase() !== grant.repository.name
          )
            checks.push({
              kind: 'repository-read',
              owner: args.owner.toLowerCase(),
              name: args.name.toLowerCase(),
            });
        }
        if (shapeName === 'query' && ['organization', 'user'].includes(name)) {
          if (typeof args.login !== 'string' || args.login.toLowerCase() !== grant.repository.owner)
            return deny('repository_mismatch');
          checks.push({ kind: 'owner-read' });
        }
        if (shapeName === 'mutation') {
          if (++mutations > 1 || !Object.hasOwn(shape.children ?? {}, name))
            return deny('operation_not_allowed');
          const decision = authorizeMutation(name, args.input, grant);
          if (!decision.allowed) return decision;
          checks.push(...decision.checks);
        }
        if (name === '__typename' || shape.scalars.includes(name)) {
          if (node.selectionSet) return deny('invalid_upstream_request');
        } else {
          const child =
            shape.children && Object.hasOwn(shape.children, name)
              ? shape.children[name]
              : undefined;
          if (!child || !node.selectionSet) return deny('operation_not_allowed');
          const decision = inspect(node.selectionSet, child, depth + 1);
          if (!decision.allowed) return decision;
        }
      }
      return allow();
    };
    const result = inspect(operation.selectionSet, operation.operation, 0);
    return result.allowed
      ? operation.operation === OperationTypeNode.QUERY
        ? allowGitHubTaskRead(checks)
        : allow(checks)
      : result;
  } catch {
    return deny('invalid_upstream_request');
  }
}

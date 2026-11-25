import { createHash } from 'node:crypto';
import {
  Kind,
  OperationTypeNode,
  parse,
  valueFromASTUntyped,
  type FieldNode,
  type SelectionSetNode,
} from 'graphql';
import { z } from 'zod';

const queryBody = z
  .object({
    query: z.string().max(65_536),
    variables: z.record(z.string(), z.unknown()),
    operationName: z.string().optional(),
  })
  .strict();

function onlyField(set: SelectionSetNode | undefined, name: string): FieldNode | undefined {
  const field = set?.selections[0];
  if (set?.selections.length === 1 && field?.kind === Kind.FIELD && field.name.value === name)
    return field;
  return undefined;
}

// The default gh display also reads nested metadata. Admit its recorded documents only
// after checking the repository and PR variables below.
const defaultViewQueries = new Set([
  'fee2da6d4ef63c7d179f117d2416487661dd993d5d7122f1b0b83d33729c912f',
  '699a348b871307b4cf5d51134eb4fed3b1991e67fef56cbd3563852db35d7182',
]);
const fields: Record<string, readonly string[]> = {
  pullRequest: [
    'id',
    'number',
    'title',
    'body',
    'state',
    'isDraft',
    'url',
    'baseRefName',
    'baseRefOid',
    'headRefName',
    'headRefOid',
    'author',
    'files',
  ],
  author: ['id', 'login', 'name', '__typename'],
  files: ['nodes', 'pageInfo', 'totalCount'],
  nodes: ['path'],
  pageInfo: ['endCursor', 'hasNextPage'],
};

function selectsReviewFields(set: SelectionSetNode, parent: string, depth = 0): boolean {
  if (depth > 8) return false;
  return set.selections.every(field => {
    if (field.kind === Kind.INLINE_FRAGMENT && parent === 'author')
      return selectsReviewFields(field.selectionSet, parent, depth + 1);
    if (field.kind !== Kind.FIELD || !fields[parent]?.includes(field.name.value)) return false;
    if (
      field.arguments?.some(
        arg => field.name.value !== 'files' || !['first', 'after'].includes(arg.name.value)
      )
    )
      return false;
    return field.selectionSet
      ? selectsReviewFields(field.selectionSet, field.name.value, depth + 1)
      : true;
  });
}

/** gh pr view and diff select one repository and one numbered pull request. */
export function isReviewQuery(json: unknown, repository: string, number: number) {
  const body = queryBody.safeParse(json);
  if (!body.success) return false;
  try {
    const doc = parse(body.data.query, { maxTokens: 2048 });
    const operation = doc.definitions[0];
    if (
      doc.definitions.length !== 1 ||
      operation?.kind !== Kind.OPERATION_DEFINITION ||
      operation.operation !== OperationTypeNode.QUERY ||
      (body.data.operationName && body.data.operationName !== operation.name?.value)
    )
      return false;
    const repo = onlyField(operation.selectionSet, 'repository');
    const pr = onlyField(repo?.selectionSet, 'pullRequest');
    if (!repo || !pr?.selectionSet || repo.arguments?.length !== 2 || pr.arguments?.length !== 1)
      return false;
    const argument = (field: FieldNode, name: string) => {
      const arg = field.arguments?.find(arg => arg.name.value === name);
      return arg ? valueFromASTUntyped(arg.value, body.data.variables) : undefined;
    };
    const owner = argument(repo, 'owner'),
      name = argument(repo, 'name');
    return (
      typeof owner === 'string' &&
      typeof name === 'string' &&
      (owner + '/' + name).toLowerCase() === repository &&
      argument(pr, 'number') === number &&
      (selectsReviewFields(pr.selectionSet, 'pullRequest') ||
        defaultViewQueries.has(createHash('sha256').update(body.data.query).digest('hex')))
    );
  } catch {
    return false;
  }
}

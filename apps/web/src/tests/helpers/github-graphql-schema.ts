import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSchema, execute, parse, validate } from 'graphql';

// The pinned GitHub SDL repeats two unrelated EnterpriseOwnerInfo fields.
const schema = buildSchema(
  readFileSync(
    resolve(__dirname, '../../../node_modules/@octokit/graphql-schema/schema.graphql'),
    'utf8'
  ),
  { assumeValidSDL: true }
);

export function validateGitHubGraphQl(query: string) {
  return validate(schema, parse(query));
}

/**
 * Answer a query from a full fixture with GitHub's schema, so the response
 * holds only the fields the query and its variables select.
 */
export async function executeGitHubGraphQl(
  query: string,
  variables: Record<string, unknown>,
  rootValue: unknown
) {
  return execute({ schema, document: parse(query), variableValues: variables, rootValue });
}

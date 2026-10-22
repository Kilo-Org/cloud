import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { GitHubTaskGrant } from '@kilocode/worker-utils/github-task-grant';
import { authorizeGitHubTaskRequest } from './github-task-policy.js';

const grant: GitHubTaskGrant = {
  revision: 1,
  scopeId: 'local-gh-compat',
  taskRef: 'refs/heads/kilo/security-test',
  repository: {
    id: 101,
    nodeId: 'R_fixture_a',
    owner: 'na2-org',
    name: 'cloud-agent-security-test-a',
  },
};
const fixtures = z
  .object({
    requests: z.array(
      z.object({
        command: z.string(),
        body: z.object({ query: z.string(), variables: z.record(z.string(), z.unknown()) }),
        publication: z.enum(['read', 'create', 'edit', 'comment']),
      })
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL('./fixtures/github-cli-task-requests.json', import.meta.url), 'utf8')
    )
  );

function authorize(body: unknown) {
  return authorizeGitHubTaskRequest(
    {
      method: 'POST',
      url: 'https://api.github.com/graphql',
      contentType: 'application/json',
      body: new TextEncoder().encode(JSON.stringify(body)),
    },
    grant
  );
}

describe('captured GitHub CLI task requests', () => {
  it.each(fixtures.requests)('permits $command ($publication) with required checks', fixture => {
    expect(authorize(fixture.body)).toEqual({
      allowed: true,
      operation: fixture.publication === 'read' ? 'read' : 'write',
      checks:
        fixture.publication === 'read'
          ? []
          : fixture.publication === 'create'
            ? []
            : fixture.publication === 'comment'
              ? [{ kind: 'repository-subject-node', nodeId: 'PR_fixture_a' }]
              : [{ kind: 'repository-pull-request-node', nodeId: 'PR_fixture_a' }],
    });
  });

  it.each(fixtures.requests.filter(fixture => fixture.publication === 'read'))(
    'checks same-owner reads from $command when its variables select another repository',
    fixture => {
      expect(
        authorize({
          ...fixture.body,
          variables: {
            ...fixture.body.variables,
            name: 'cloud-agent-security-test-b',
            repo: 'cloud-agent-security-test-b',
          },
        })
      ).toEqual({
        allowed: true,
        operation: 'read',
        checks: [
          {
            kind: 'repository-read',
            owner: grant.repository.owner,
            name: 'cloud-agent-security-test-b',
          },
        ],
      });
    }
  );

  it.each([
    'reviewRequests(first: 1) { nodes { requestedReviewer { ... on Team { organization { repositories(first: 1) { nodes { name } } } } } } }',
    'projectItems(first: 1) { nodes { project { items(first: 1) { nodes { id } } } } }',
    'projectItems(first: 1) { nodes { fieldValueByName(name: "Private notes") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }',
    'commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 1) { nodes { ... on CheckRun { checkSuite { workflowRun { repository { name } } } } } } } } } }',
  ])('denies traversal outside related identity metadata: %s', selection => {
    expect(
      authorize({
        query: `query { repository(owner: "na2-org", name: "cloud-agent-security-test-a") { pullRequest(number: 42) { ${selection} } } }`,
      }).allowed
    ).toBe(false);
  });
});

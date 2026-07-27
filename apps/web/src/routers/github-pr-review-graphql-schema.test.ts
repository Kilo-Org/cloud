// Schema-validity test for every raw PR-Review GraphQL document in
// `github-pr-review-router.ts`. Pinned against GitHub's official GraphQL SDL
// (bundled in `@octokit/graphql-schema`, auto-updated by that package) using
// `graphql`'s `parse` + `validate` so a future GitHub schema change or a
// hand-edited typo is caught at test time rather than at runtime against
// `octokit.request('POST /graphql', …)`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildClientSchema, parse, validate } from 'graphql';

import { describe, test, expect } from '@jest/globals';

import { PR_REVIEW_GRAPHQL_DOCUMENTS } from '@/routers/github-pr-review-router';

// `@octokit/graphql-schema` is published as an ESM-only package (`"type":
// "module"`), which Jest's CJS test runner cannot `import` directly without
// enabling `--experimental-vm-modules`. We still depend on the package — it
// auto-updates `schema.json` (GitHub's authoritative GraphQL introspection
// result) and `schema.graphql` (the matching SDL) on every GitHub schema
// change — and read the introspection JSON off disk so the dependency is
// exercised. `buildClientSchema` is the recommended way to materialize a
// schema from an introspection result and is what `@octokit/graphql-schema`'s
// own `validate` helper uses internally; the SDL cannot be passed to
// `buildSchema` directly because it contains extension types that the strict
// SDL builder rejects. If the dependency is silently dropped, this read
// fails and the test errors loudly.
const introspectionPath = join(__dirname, '../../node_modules/@octokit/graphql-schema/schema.json');
const introspection = JSON.parse(readFileSync(introspectionPath, 'utf8'));
const githubSchema = buildClientSchema(introspection);

describe('github-pr-review-router GraphQL documents', () => {
  test('exports exactly 10 documents (sanity guard for the export record)', () => {
    expect(Object.keys(PR_REVIEW_GRAPHQL_DOCUMENTS)).toHaveLength(10);
  });

  test.each(Object.entries(PR_REVIEW_GRAPHQL_DOCUMENTS))(
    '%s is valid against the GitHub GraphQL schema',
    (_name, doc) => {
      const parsed = parse(doc);
      const errors = validate(githubSchema, parsed);
      expect(errors).toEqual([]);
    }
  );

  test('validate() flags a deliberately broken document (teeth guard)', () => {
    // Reference a field that does not exist on the GitHub `Repository` type
    // (`definitelyNotAFieldOnRepository`). If validate() ever stops being
    // strict, this test will start passing-on-bad-docs and the guard fails.
    const broken = /* GraphQL */ `
      query BrokenTeethGuard {
        repository(owner: "x", name: "y") {
          definitelyNotAFieldOnRepository
        }
      }
    `;
    const parsed = parse(broken);
    const errors = validate(githubSchema, parsed);
    expect(errors.length).toBeGreaterThan(0);
  });
});

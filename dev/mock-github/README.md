# Mock GitHub API for PR review

The PR-review router reads GitHub through a client that honors the
`GITHUB_API_BASE_URL` environment variable. Pointing that variable at this
server lets the mobile merge and overview surfaces render with fixture data and
a dev user token, with no provider connection and no network access.

## Run

```bash
pnpm dev:mock-github
```

The server binds to loopback and prints the port it uses (`MOCK_GITHUB_PORT`,
default `4790`). Set `GITHUB_API_BASE_URL` to that address in the root
environment file, then restart the web app and the git-token service.

`MOCK_GITHUB_MERGE_MODE=success` makes a merge call report a completed merge.
The branch-delete request still fails, which surfaces the partial-success
banner; the default mode reports an unmerged result.

## Fixtures

The fixtures live in `fixtures.ts` and cover the two states the merge section
branches on:

| Pull request | State | Surface |
|---|---|---|
| 1 | mergeable, clean | merge sheet, merge action, partial-success banner |
| 2 | `mergeable: false` with a `clean` state | blocked reasons list (mergeability not yet reported) |

Repository and pull-request reads, check runs, commit statuses, files, and the
overview, review-thread, and conversation GraphQL queries are answered for the
`acme/widgets` fixture repository.

## Sign in the dev user

The router returns a credential only for a user that owns a GitHub user-token
row. Seed one for a local account with the dev-only E2E helper
`seedUserGithubToken`, then open a pull-review deep link for the fixture
repository.

## Expected client calls

The server logs nothing; an unexpected request answers 404 with the path, so a
missing route is visible in the app's error state.

# CI and required checks

The `main-tests` ruleset (id 12440145) requires these status checks on `main`,
each pinned to the GitHub Actions app (integration id 15368):

| Context | Published by |
|---|---|
| `test` | `ci.yml` job `test` |
| `build` | `ci.yml` job `build` |
| `typecheck` | `ci.yml` job `typecheck` |
| `format-check` | `ci.yml` job `format-check` |
| `lint` | `ci.yml` job `lint` |
| `catalog (PR)` | `kilo-mcp-catalog.yml` job `catalog (PR)` |
| `i18n-leftover` | `kilo-app-ci.yml` job `i18n-leftover` |
| `check-unused` | `kilo-app-ci.yml` job `check-unused` |
| `mobile-typecheck` | `kilo-app-ci.yml` job `mobile-typecheck` |
| `mobile-lint` | `kilo-app-ci.yml` job `mobile-lint` |
| `mobile-test-result` | `kilo-app-ci.yml` job `mobile-test-result` |

The three mobile checks must stay in the required list. `ci.yml` deliberately
excludes `apps/mobile`: `scripts/affected-workspaces.mjs` keeps it out of the
rest-lint group and the workspace-test matrix has no `apps/mobile` row. Without
the mobile checks a mobile-only pull request could satisfy `lint`, `typecheck`
and `test` with those skipped rows, run the mobile suite nowhere in the
required gate, and fail only later in the merge queue.

## Check names must be unique across workflows

GitHub matches a required context by name and app, not by workflow. If two
workflows publish the same check name, either workflow's passing run satisfies
the requirement, so one workflow's failure can be masked by the other's pass.
That happened when `ci.yml` and `kilo-app-ci.yml` both published `test`,
`typecheck` and `lint`: the mobile workflow's pass satisfied the ruleset while
the main CI's check failed.

Rules:

- A required context must have exactly one publisher per workflow name: one
  workflow publishes it, and no other workflow may reuse that name.
- A job's check name is its `name:` value, or its job id when no name is set.
  Both live in the workflow file, so a rename is complete only when every
  `needs:` and `needs.<id>` reference moves with it.
- The mobile workflow (`kilo-app-ci.yml`) prefixes every job that mirrors a
  context `ci.yml` publishes with `mobile-`: `mobile-typecheck`, `mobile-lint`
  and `mobile-test-result` (the mobile Vitest aggregator). Its shard jobs are
  already unique as `mobile-test (1/4)` and so on.
- `i18n-leftover` and `check-unused` keep their unprefixed names because
  `kilo-app-ci.yml` is their only publisher. Renaming them would make those
  required contexts unsatisfiable until the ruleset or `ci.yml` gains an
  equivalent, so change both together.
- Workflows that publish checks but do not run on `pull_request` or `merge_group`
  (for example `explorer-ios-release.yml` job `build`) never satisfy the
  ruleset on a PR, so they are excluded from the uniqueness comparison.

`scripts/typecheck-ci.test.mjs` pins this: it derives every publishing workflow
from the required context list above, asserts each context has exactly one
publisher, asserts every `mobile-`-prefixed required context belongs to
`kilo-app-ci.yml`, and asserts the mobile workflow has no bare `test`,
`typecheck` or `lint` job.

## Aggregators

`test` in `ci.yml` is the main CI fan-in. It needs every job whose failure would
otherwise only skip another required check, and it fails when any of them
fails or is cancelled. A skipped job satisfies a required check, so an
unrelated change passes the gate while the work stays skipped.

`mobile-test-result` in `kilo-app-ci.yml` is the mobile fan-in and follows the
same rule for its shards and producers. It is required as well: `ci.yml` has no
`apps/mobile` rows, so the mobile suite is the only gate for that app.

## Adding or renaming a required check

1. Change the workflow and every reference in it, plus the wiring test and this
   document, in one pull request.
2. Update the `main-tests` ruleset (12440145) in a separate step: rulesets live
   outside the repository. Because GitHub matches by name, the ruleset must
   name the new context before the old context stops being reported, or PRs
   stay blocked on an expected check. The mobile context rename in this change
   is followed by a separate ruleset edit that adds `mobile-typecheck`,
   `mobile-lint` and `mobile-test-result` to the required list; the old `test`,
   `typecheck` and `lint` contexts stay, now supplied only by `ci.yml`.

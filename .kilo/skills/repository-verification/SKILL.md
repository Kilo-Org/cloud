---
name: repository-verification
description: Finish implementation, select tests, validate changed code, or prepare a commit in this monorepo. Use to choose narrow checks, prepare test dependencies, run formatting, or report verification accurately.
---

# Repository verification

Read root and relevant package `package.json` files before selecting commands. Prefer the narrowest relevant package checks or `scripts/typecheck-all.sh --changes-only` over broad repository checks.

## Root commands

| Command | Meaning |
|---|---|
| `pnpm typecheck` | Runs `scripts/typecheck-all.sh`. |
| `pnpm lint` | Runs `scripts/lint-all.sh`. |
| `pnpm test` | Runs web tests, then `test:web-env`; it does not run every package suite. |
| `pnpm validate` | Runs root typecheck, lint, and test scripts. |
| `pnpm format` | Formats supported files with `oxfmt`. |
| `pnpm format:check` | Lists supported files that differ from `oxfmt`. |
| `pnpm format:changed` | Formats supported files changed from `main`. |

Run `pnpm format` before committing.

During iteration, format only changed files when possible to avoid unrelated
working-tree changes. Run `git diff --check` before finishing.

## Test dependencies

Before tests that use shared PostgreSQL, check whether it is running with:

```bash
docker compose -f dev/docker-compose.yml ps postgres
```

If it is not active, run `pnpm test:db`; this starts PostgreSQL and applies migrations. Pure unit suites and Durable Object SQLite suites do not automatically need shared PostgreSQL.

Report exact checks run and their results. Do not describe targeted checks as full validation.

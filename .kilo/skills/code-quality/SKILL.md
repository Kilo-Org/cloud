---
name: code-quality
description: Write, change, or review TypeScript or JavaScript in this monorepo. Use for implementation, refactoring, code review, dependency selection, type-safety decisions, comments, tests, or lint cleanup.
---

# Code quality

Read root `package.json` and relevant package `package.json` files before running repository JavaScript, package scripts, or adding functionality. Inspect installed dependencies first and use an existing package where it fits; manifests are source of truth, not a static inventory.

## Constraints

- Prefer TypeScript `type` over `interface`.
- Use runtime validation for genuinely unknown, external, user-controlled, persisted, or unowned API data.
- Do not hide uncertainty with `as any`, double casts through `unknown`, or non-null assertions. Prefer explicit checks or flow-sensitive typing.
- Use `as` sparingly. Prefer `satisfies`, discriminated unions, generics, or flow-sensitive narrowing when TypeScript can express the fact.
- A targeted `as` is acceptable at a known boundary where control flow guarantees the type. For example, inside a platform switch, casting `message` to `Message<SlackEvent>` or `Message<GitHubRawMessage>` is better than generic `Record<string, unknown>` helpers for known adapter fields.
- Test files and fixtures may use casts for fixture construction, partial mocks, and error paths. Production conventions still apply to non-test code imported by tests.
- Fix unused values at their cause. Remove dead parameters or code, or use a value accidentally ignored. Prefix with `_` only for intentionally unused positional parameters such as `(_req, res)`.

## Maintainability guidance

- Keep solutions simple. Do not over-abstract or prematurely generalize; flag real DRY violations.
- Prefer closures over trivial TypeScript classes.
- Use clear names for variables, functions, and tests. Add brief comments only for behavior that is not clear in context.
- Keep comments current. Update or remove stale comments and delete comments with no value to a future maintainer.
- Preserve external API spelling, including `snake_case` or unusual naming, rather than converting it for convention. Simple, searchable code beats clever-looking code.
- Avoid mocks when observing a result or database side effect is practical. When a dependency cannot be tested indirectly, make it an explicit argument and pass a fake.
- Keep functions simple. Do not add an argument only to spread options into a result when the caller can do that directly.

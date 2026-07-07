---
description: Create a pull request following repo conventions
---

Create a pull request for the current branch following the repo conventions below. $ARGUMENTS

Before opening the PR, inspect the branch: review all commits on it (not just the latest), `git status`, `git diff` against the base branch, and remote tracking state.

## Titles

- Format: `type(scope): <description>` (e.g., `feat(auth): add SSO login`)
- Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`, `style`, `perf`
- Imperative mood, under 72 characters, no trailing period.

## Descriptions

Follow the PR template in `.github/pull_request_template.md`. Every description must include four sections in order:

1. **`## Summary`** — What changed and why. Outcome-focused, call out architectural changes.
2. **`## Verification`** — Manual verification only. Do not list automated checks such as `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm validate`, CI, or formatting commands here.
3. **`## Visual Changes`** — Before/after screenshots, or `N/A`.
4. **`## Reviewer Notes`** — Risk areas, tricky logic, rollout notes, or `N/A`.

Do not leave HTML comments from the template. Review all commits on the branch when writing the summary.

## Workflow

- Create PRs as **ready for review** by default. Only use `--draft` if explicitly requested.
- When assigning PRs or issues, resolve the GitHub username with `gh api user --jq '.login'`. Never guess usernames.
- Never use `--force`, `--no-verify`, or any other flag that bypasses git hooks without explicit user approval. If a hook or check fails, diagnose and fix it or ask how to proceed — do not silently skip it.

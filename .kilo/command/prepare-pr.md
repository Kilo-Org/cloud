# Prepare PR

Prepare a pull request description using this repository's PR template and then create or update the PR.

Arguments:

- `--draft` — Create the PR as a draft instead of ready for review.

## Required source of truth

- Read and use `/.github/pull_request_template.md` from this repository.
- Preserve section headings and order exactly as they appear in the template.
- Do not add sections that are not present in the template.

## PR title

- Use the format `type(scope): <description>` (e.g., `feat(auth): add SSO login`).
- Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`, `style`, `perf`.
- Keep the title under 72 characters, use imperative mood, and do not end with a period.

## Build the PR description

1. Collect branch context.
   - Run git commands to understand all changes that will be included in the PR.
   - Include all commits since branch divergence, not just the latest commit.

2. Prefill `## Summary`.
   - Describe what changed and why.
   - Explicitly call out any architectural changes.
   - Include enough context for a reviewer unfamiliar with this code area.
   - Keep it concise and reviewer-friendly.

3. Prefill `## Verification` from this session.
   - Capture verification already performed in this session (tests, typecheck, lint, builds, manual checks).
   - Include command names and short pass/fail outcomes when available.
   - Add a final placeholder bullet for extra user-provided verification details.

4. Prepare `## Visual Changes`.
   - Detect likely visual/UI changes from changed files (for example: `*.tsx`, `*.jsx`, CSS, Tailwind config, component/page/view files).
   - If visual/UI changes are likely, keep the before/after screenshot table and add meaningful row labels/placeholders.
   - If no visual/UI changes are likely, replace the section content with `N/A`.

5. Prefill `## Reviewer Notes`.
   - Add concise context that helps reviewer efficiency (risk areas, tricky logic, rollout notes).
   - Keep this section brief.

## Confirm with the user

- Print the full generated PR description in markdown.
- Ask for confirmation and any edits.
- Apply edits and show the final version before writing it to GitHub.

## Create or update PR

1. Check whether a PR already exists for the current branch.
2. If a PR exists, update the PR body using `gh pr edit --body`.
3. If a PR does not exist:
   - If `--draft` was passed as an argument, create it as a draft using `gh pr create --draft`.
   - Otherwise, create it as ready for review using `gh pr create`.
4. Return the PR URL.

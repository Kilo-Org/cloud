# Workflow Learnings

Environment blockers and their fixes, recorded by the planner or orchestrator for the role that hit them. The full contract — when to read, when to write, entry shape, deduplication — is in [MOBILE_WORKFLOW.md](MOBILE_WORKFLOW.md).

## Planner

### Uncommitted `.kilo/` edits are reverted by the next role agent

- Symptom: a learning the planner wrote to this file vanished; the dispatched verifier's report said it
  "restored an accidental edit" and left the worktree clean.
- Cause: role agents snapshot `git status` as their baseline before any temporary edit and restore
  anything they find modified. A planner note sitting uncommitted looks exactly like an agent's own
  stray edit.
- Fix: whoever writes to this file gets it **committed** before the next role agent is dispatched. The
  planner cannot commit (the orchestrator owns Git), so a planner-authored entry must be named in the
  handoff as work to commit in the first commit — otherwise the first dispatched agent erases it.

### In-app cloud-agent session creation needs a GitHub integration

- Symptom: the new-session screen cannot create a cloud-agent session on a fresh local stack — the
  repository section is empty and the flow dead-ends.
- Cause: the E2E account has no GitHub integration, so `listGitHubRepositories` returns nothing.
- Fix: for flows that just need "a session with a transcript, cost and context usage", use the remote
  CLI path (`apps/mobile/e2e/remote-cli.sh start`, then prompt it) instead of a cloud-agent session.
  Wire up GitHub only when the cloud-agent create flow itself is what is under test. A blocked
  cloud-agent create on a fresh stack is a test-environment limitation, not a product failure.

## Orchestrator

### Kilobot's mention handle is `@kilocode-bot`, not `@kilo-code-bot`

- Symptom: the step-9 "retrigger Kilobot with a PR comment tagging it" path silently does nothing — the
  comment posts, no review follows — when the mention uses the login the bot's own comments show.
- Cause: Kilobot reviews are posted by a GitHub **App**, whose author login is `kilo-code-bot[bot]`.
  That name is not mentionable: `gh api users/kilo-code-bot` returns 404. The mentionable account is
  the separate GitHub *User* `kilocode-bot` (`gh api users/kilocode-bot` returns 200).
- Fix: write `@kilocode-bot` in the retrigger comment (still prefixed `(bot) ` per GitHub
  Communication). Keep matching the *author* login as `kilo-code-bot[bot]` when reading threads — the
  handle you tag and the login you match are deliberately different, so do not "correct" author-login
  allowlists such as `KILO_GITHUB_BOT_LOGINS` in
  `apps/web/src/lib/code-reviews/review-memory/github-feedback.ts`.
- If the mention still draws a "link your GitHub account to Kilo" reply, fall back to the empty-commit
  retrigger (`git commit --allow-empty`), which needs no account linking.

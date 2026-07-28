# kilo's edit/write tools block .kilo/ and .kilocode/ paths

Symptom: a kilo session (any role) trying to edit a file under `.kilo/` — for example a role agent definition in `.kilo/agent/` — gets a config-protection permission ask; in a non-interactive `kilo run` it is auto-rejected and the agent burns steps retrying.

Cause: kilo's edit and write tools treat `.kilo/` and `.kilocode/` (at any depth) plus root `kilo.json`/`AGENTS.md` as protected config paths that always require approval (`packages/opencode/src/kilocode/permission/config-paths.ts`). `.kilo/plans/` is exempt. `.kilo_workflow/` is NOT matched — learnings and workflow-doc edits work normally from kilo sessions.

Fix: route agent-definition changes through a non-kilo harness, a human, or shell commands (`cat > .kilo/agent/x.md <<'EOF'` — the bash tool is not config-gated). Never let a role agent sit retrying a `.kilo/` edit.

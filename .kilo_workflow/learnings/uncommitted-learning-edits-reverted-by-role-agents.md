# Uncommitted learning edits are reverted by the next role agent

Symptom: a learning written to `.kilo_workflow/learnings/` vanished; the next dispatched role agent's report said it "restored an accidental edit" and left the worktree clean.

Cause: role agents snapshot `git status` as their baseline before any temporary edit and restore anything they find modified. An uncommitted learning file looks exactly like an agent's own stray edit.

Fix: whoever writes a learning gets it **committed** before the next role agent is dispatched. The planner cannot commit (the orchestrator owns Git), so a planner-authored entry must be named in the handoff as work to commit in the first commit — otherwise the first dispatched agent erases it.

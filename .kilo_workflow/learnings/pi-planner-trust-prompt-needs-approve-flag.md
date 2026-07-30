# pi planner wedges on "Trust project folder?" at launch

**Symptom:** A pi-harness planner/orchestrator launched via `launch-interactive.sh` shows an interactive `Trust project folder?` dialog and never starts working.

**Cause:** Fresh worktrees are untrusted; pi blocks on its trust prompt before loading project resources, and the tmux launch cannot answer it.

**Fix:** Pass `--approve` in the pi command line (per-run trust; does not mutate pi settings):

```bash
.kilo_workflow/launch-interactive.sh <section>-planner <worktree> --log "$SCRATCH/planner.log" \
  pi --approve --model kilocode/kilo-internal/kimi-k3 --thinking high "<planner role message>" "@$SCRATCH/brief.md"
```

Do not resolve it by pressing Enter on the persisted `Trust` option — that silently writes the worktree path into the user's pi settings.

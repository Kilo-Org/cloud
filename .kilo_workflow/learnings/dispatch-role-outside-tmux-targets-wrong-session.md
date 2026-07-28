# dispatch-role.sh lands in a foreign session when invoked outside tmux

- Symptom: a dispatched role agent (plan-reviewer, implementer, impl-reviewer) appears as a
  window in **another** workflow run's tmux session, so its dispatcher cannot see it, and the
  foreign run's monitor sees a window it did not start.
- Cause: `dispatch-role.sh` targets `tmux new-window -t "$(tmux display-message -p '#S')"`. With
  no client attached to the caller's session — e.g. a Claude Code starter/planner driving the run
  from a plain shell — `display-message` resolves against tmux's most-recently-used session, which
  is whatever another run last attached to. The `e2e-verifier` path is unaffected (it creates its
  own session by name).
- Fix: never call `dispatch-role.sh` from a shell outside the section's own session. Launch it
  through the section session so `$TMUX` is set inside the calling pane:

  ```bash
  tmux new-window -d -t "$SECTION" -n "dispatch-$ROLE-$LABEL" \
    "cd $WT && .kilo_workflow/dispatch-role.sh $ROLE $SECTION $LABEL $WT $SCRATCH 'Review …' --file $SCRATCH/plan.md"
  ```

  The log path is deterministic (`$SCRATCH/<role>-<label>.log`), so nothing is lost by not
  reading the script's stdout.

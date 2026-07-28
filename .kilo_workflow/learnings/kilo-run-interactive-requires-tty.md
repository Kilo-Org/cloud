# kilo run --interactive dies when stdout is piped

Symptom: launching an interactive session as `kilo run ... --interactive ... | tee log` exits immediately with `Error: --interactive requires a TTY stdout`.

Cause: piping stdout replaces the TTY that `--interactive` requires. Affects any attempt to tee an interactive kilo session's output to a file.

Fix: launch the interactive session as the tmux window command with no pipe, then attach logging separately with `tmux pipe-pane -t <session>:<window> -o "cat >> <logfile>"`. Read live state with `tmux capture-pane -p -t <session>:<window>`. Non-interactive dispatches are unaffected and can still be redirected.

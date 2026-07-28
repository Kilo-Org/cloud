#!/usr/bin/env bash
# Deliver a message to a running interactive kilo session (starter, planner,
# orchestrator) and prove it landed.
#
#   steer.sh <tmux-target> <message>     # message text, or - to read stdin
#
# Traps this exists for (see learnings/steering-a-running-kilo-session.md):
#
#   1. `tmux send-keys -t <t> "$MSG" Enter` submits short messages but NOT long
#      ones — kilo's composer reads a large chunk as a paste and swallows the
#      trailing Enter, so the text sits unsent in the input box forever. That is
#      the "wedged" session agents keep reporting. Enter must arrive as its own
#      keystroke, after the text.
#   2. A delivered message only reaches the model at the next turn boundary. The
#      footer shows `N queued` until then, which is delivery working, not a wedge.
#
# Exit 0 once the message is submitted; prints `queued` (waiting for the current
# turn to end) or `running` (the session picked it up immediately). Exit 1 with
# the pane tail if it could not be submitted — the message may be sitting in the
# composer, so fix the target rather than sending a second copy.
set -euo pipefail

TARGET=${1:?tmux target — session, window or pane}
MSG=${2:?message text, or - for stdin}
[ "$MSG" = "-" ] && MSG=$(cat)
[ -n "${MSG//[[:space:]]/}" ] || { echo "steer: empty message" >&2; exit 1; }

CMD=$(tmux display-message -p -t "$TARGET" '#{pane_current_command}' 2>/dev/null || true)
[ -n "$CMD" ] || { echo "steer: no such tmux target: $TARGET" >&2; exit 1; }
# A mistargeted steer pasted into a shell pane RUNS as a shell command. Only
# panes running the kilo CLI (node, or bun on a source checkout) are steerable.
case $CMD in
  node | bun | kilo) ;;
  *)
    echo "steer: $TARGET is running '$CMD', not a kilo CLI — refusing to paste into it" >&2
    exit 1
    ;;
esac

# -J joins wrapped lines, so a needle survives the pane's width.
pane() { tmux capture-pane -pJ -t "$TARGET"; }
# The footer renders `<n> queued`; absent means nothing is waiting.
queued() { pane | grep -oE '[0-9]+ queued' | tail -1 | cut -d' ' -f1 || true; }
# First line of the message, whitespace-collapsed, as the needle for the
# submitted `›`-prefixed echo in the scrollback.
needle=$(printf '%s' "${MSG%%$'\n'*}" | tr -s '[:space:]' ' ' | cut -c1-60)
# Per-invocation buffer: the tmux server's buffers are shared, so a fixed name
# lets two sections steering at once paste each other's message.
BUF=kilo-steer-$$

before=$(queued); before=${before:-0}

# load-buffer + paste-buffer, not send-keys: the message travels as data, so a
# literal `Enter`, `;` or `C-c` in the text cannot be read as a key name. `-p`
# wraps it in bracketed paste, which keeps a multi-line message as ONE prompt —
# an unbracketed paste submits at every newline, so a three-line steer arrives
# as three prompts and the first fragment gets acted on alone.
tmux load-buffer -b "$BUF" - <<<"$MSG"
tmux paste-buffer -d -p -b "$BUF" -t "$TARGET"

# Separate keystroke, after the composer has settled — trap 1.
for _ in 1 2 3; do
  sleep 1
  tmux send-keys -t "$TARGET" Enter
  for _ in 1 2 3 4; do
    sleep 1
    now=$(queued); now=${now:-0}
    if [ "$now" -gt "$before" ]; then echo "queued"; exit 0; fi
    # Submitted and started: the scrollback echoes it as a user message. Match
    # only lines the composer cannot produce, so unsent text is never a pass.
    if pane | grep -qF "› $needle"; then echo "running"; exit 0; fi
  done
done

echo "steer: NOT submitted after 3 attempts — inspect $TARGET before resending" >&2
pane | grep -vE '^ *$' | tail -15 >&2
exit 1
